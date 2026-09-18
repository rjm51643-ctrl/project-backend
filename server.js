// Plumbline backend — proxies property data lookups, hides API keys server-side,
// caches results, and computes a proprietary "data confidence" score.
//
// Run locally:   npm install && npm start
// Env required:  RENTCAST_API_KEY (see .env.example)

require('dotenv').config();
const express = require('express');
const cors = require('cors');

function num(v){ const n = parseFloat(v); return isNaN(n) ? 0 : n; }

const app = express();
app.set('trust proxy', true);
app.use(cors()); // tighten this to your real frontend origin before going live
app.use(express.json());

// ---- basic per-IP rate limiting for the public-facing lookup endpoint ----
// Prevents a bot or a single visitor from burning through your RentCast quota.
// Swap for a real rate-limit store (Redis) if you outgrow a single server instance.
const RATE_LIMIT_MAX = 15;               // requests
const RATE_LIMIT_WINDOW_MS = 1000 * 60 * 60; // per hour
const rateLimitHits = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const entry = rateLimitHits.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitHits.set(ip, { count: 1, windowStart: now });
    return next();
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests — please try again later.' });
  }
  entry.count++;
  next();
}

const RENTCAST_API_KEY = process.env.RENTCAST_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

// ---- simple in-memory cache (swap for Redis/Postgres once this needs to survive restarts) ----
const AVM_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 3;       // 3 days — comps shift somewhat over time
const RECORD_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 180;  // 180 days — tax/sale/HOA records barely change
const cache = new Map();

function getCached(key, ttl) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.timestamp > ttl) { cache.delete(key); return null; }
  return hit.data;
}
function setCached(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// ---- data provider call (RentCast today; swappable later without touching the frontend) ----
async function fetchRentcast(path, address, extraParams = {}) {
  if (!RENTCAST_API_KEY) throw new Error('Server is missing RENTCAST_API_KEY');
  const params = new URLSearchParams({ address, ...extraParams });
  const url = `https://api.rentcast.io/v1/${path}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }
  });
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'Invalid RentCast API key' : `RentCast request failed (${res.status})`);
  }
  return res.json();
}

// ---- proprietary layer: turn a raw AVM range into a 0-100 confidence score ----
// Narrower range relative to the point estimate + more comps = higher confidence.
// This is the kind of derived signal a raw data API doesn't hand you directly.
// ---- property records: real tax history, last sale price, HOA, county unit count ----
// This is a different RentCast endpoint from the AVM ("/properties" vs "/avm/*") — county
// record data, not a model estimate, so it's the right source for things like taxes.
async function fetchRentcastPropertyRecord(address) {
  if (!RENTCAST_API_KEY) throw new Error('Server is missing RENTCAST_API_KEY');
  const params = new URLSearchParams({ address, limit: '1' });
  const url = `https://api.rentcast.io/v1/properties?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }
  });
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'Invalid RentCast API key' : `RentCast request failed (${res.status})`);
  }
  const records = await res.json();
  return Array.isArray(records) ? records[0] : records;
}

function shapePropertyRecord(record) {
  if (!record) return null;
  let annualPropertyTax = null;
  if (record.propertyTaxes) {
    const years = Object.keys(record.propertyTaxes).sort().reverse();
    if (years.length) annualPropertyTax = record.propertyTaxes[years[0]].total;
  }
  return {
    lastSalePrice: record.lastSalePrice ?? null,
    lastSaleDate: record.lastSaleDate ?? null,
    annualPropertyTax,
    hoaFeeMonthly: record.hoa && record.hoa.fee ? record.hoa.fee : null,
    countyUnitCount: record.features && record.features.unitCount ? record.features.unitCount : null,
    squareFootage: record.squareFootage ?? (record.features && record.features.squareFootage) ?? null
  };
}

function confidenceScore(estimate, isRent) {
  if (!estimate) return null;
  const point = isRent ? estimate.rent : estimate.price;
  const low = isRent ? estimate.rentRangeLow : estimate.priceRangeLow;
  const high = isRent ? estimate.rentRangeHigh : estimate.priceRangeHigh;
  if (!point || !low || !high) return null;
  const spreadPct = (high - low) / point;
  const compCount = Array.isArray(estimate.comparables) ? estimate.comparables.length : 0;
  const compBonus = Math.min(compCount, 10) * 1.2;
  const score = Math.round(Math.max(0, Math.min(100, 100 - spreadPct * 140 + compBonus)));
  return score;
}

function shapeEstimate(raw, isRent, unitCount) {
  if (!raw) return null;
  const perUnit = isRent ? raw.rent : raw.price;
  const perUnitLow = isRent ? raw.rentRangeLow : raw.priceRangeLow;
  const perUnitHigh = isRent ? raw.rentRangeHigh : raw.priceRangeHigh;

  // RentCast returns a SINGLE-UNIT rent estimate for Multi-Family/Apartment property types,
  // but a BUILDING-level value estimate. Only scale the rent side, and only when we know unit count.
  const shouldScale = isRent && unitCount && unitCount > 1;
  const estimate = shouldScale ? perUnit * unitCount : perUnit;
  const low = shouldScale ? perUnitLow * unitCount : perUnitLow;
  const high = shouldScale ? perUnitHigh * unitCount : perUnitHigh;

  return {
    estimate,
    low,
    high,
    perUnit: isRent ? perUnit : null,
    scaledToUnits: shouldScale ? unitCount : null,
    confidence: confidenceScore(raw, isRent),
    comps: (raw.comparables || []).slice(0, 5).map(c => ({
      address: c.formattedAddress,
      price: c.price,
      distanceMiles: c.distance,
      similarity: c.correlation
    }))
  };
}

// ---- routes ----
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Server-side AI text generation — uses YOUR Anthropic API key, never exposed to the browser.
// Works from any hosted domain, unlike calling api.anthropic.com directly from client-side code
// (that only works inside Claude's own chat preview, not on a real public site).
app.post('/api/ai-summary', rateLimit, async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt is required' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // fast and cheap — right-sized for a short teaser paragraph
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data.error?.message || 'Anthropic API request failed' });
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    res.json({ text });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- waitlist capture (for the free Health Score landing page) ----
const waitlist = []; // swap for a real database before you have meaningful volume — this resets on redeploy

app.post('/api/waitlist', (req, res) => {
  const { email, address, score } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  waitlist.push({ email, address: address || null, score: score ?? null, capturedAt: new Date().toISOString() });
  res.json({ ok: true });
});

// Protected: view captured leads. Set ADMIN_KEY in your environment variables, then visit
// /api/waitlist?key=yourkey to see signups. Without ADMIN_KEY set, this route is disabled.
app.get('/api/waitlist', (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  res.json({ count: waitlist.length, waitlist });
});

// ---- peer benchmarking ----
// Anonymized only: propertyType + a 3-digit zip prefix (not the full zip, not the address).
// This is intentionally built before you have enough users for it to be statistically meaningful —
// the pipe needs to exist now so it's ready once volume justifies it.
const benchmarkData = new Map(); // `${propertyType}|${zip3}` -> [{ capRate, cashOnCash, ts }]
const MIN_BENCHMARK_SAMPLE = 5;

app.post('/api/benchmark/contribute', (req, res) => {
  const { propertyType, zip3, capRate, cashOnCash } = req.body || {};
  if (!propertyType || !zip3 || typeof capRate !== 'number') {
    return res.status(400).json({ error: 'propertyType, zip3, and capRate are required' });
  }
  const key = `${propertyType}|${zip3}`;
  const arr = benchmarkData.get(key) || [];
  arr.push({ capRate, cashOnCash: cashOnCash ?? null, ts: Date.now() });
  benchmarkData.set(key, arr);
  res.json({ ok: true, sampleSize: arr.length });
});

app.get('/api/benchmark/compare', (req, res) => {
  const { propertyType, zip3, capRate } = req.query;
  const key = `${propertyType}|${zip3}`;
  const arr = benchmarkData.get(key) || [];
  if (arr.length < MIN_BENCHMARK_SAMPLE) {
    return res.json({ insufficientData: true, sampleSize: arr.length, minimumNeeded: MIN_BENCHMARK_SAMPLE });
  }
  const value = parseFloat(capRate);
  const below = arr.filter(x => x.capRate < value).length;
  const percentile = Math.round((below / arr.length) * 100);
  res.json({ insufficientData: false, sampleSize: arr.length, percentile });
});

app.get('/api/lookup', rateLimit, async (req, res) => {
  const address = (req.query.address || '').trim();
  const propertyType = (req.query.propertyType || '').trim();
  const squareFootage = req.query.squareFootage ? Number(req.query.squareFootage) : null;
  const units = req.query.units ? Number(req.query.units) : 1;

  if (!address) return res.status(400).json({ error: 'address query param is required' });

  const avmKey = ['avm', address.toLowerCase(), propertyType, squareFootage, units].join('|');
  const recordKey = ['record', address.toLowerCase()].join('|');

  let avmResult = getCached(avmKey, AVM_CACHE_TTL_MS);
  let avmCached = !!avmResult;
  if (!avmResult) {
    const extraParams = {};
    if (propertyType) extraParams.propertyType = propertyType;
    if (squareFootage) extraParams.squareFootage = squareFootage;
    const [valueRes, rentRes] = await Promise.allSettled([
      fetchRentcast('avm/value', address, extraParams),
      fetchRentcast('avm/rent/long-term', address, extraParams)
    ]);
    avmResult = {
      value: valueRes.status === 'fulfilled' ? shapeEstimate(valueRes.value, false, units) : null,
      rent: rentRes.status === 'fulfilled' ? shapeEstimate(rentRes.value, true, units) : null,
      errors: {
        value: valueRes.status === 'rejected' ? valueRes.reason.message : null,
        rent: rentRes.status === 'rejected' ? rentRes.reason.message : null
      }
    };
    if (avmResult.value || avmResult.rent) setCached(avmKey, avmResult);
  }

  let recordResult = getCached(recordKey, RECORD_CACHE_TTL_MS);
  let recordCached = !!recordResult;
  if (!recordResult) {
    try {
      const raw = await fetchRentcastPropertyRecord(address);
      recordResult = { record: shapePropertyRecord(raw), errors: { record: null } };
    } catch (err) {
      recordResult = { record: null, errors: { record: err.message } };
    }
    if (recordResult.record) setCached(recordKey, recordResult);
  }

  res.json({
    address,
    cached: avmCached && recordCached,
    value: avmResult.value,
    rent: avmResult.rent,
    record: recordResult.record,
    errors: { ...avmResult.errors, ...recordResult.errors }
  });
});

app.listen(PORT, () => console.log(`Plumbline backend listening on port ${PORT}`));
