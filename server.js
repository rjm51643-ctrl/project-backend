// Plumbline backend — proxies property data lookups, hides API keys server-side,
// caches results, and computes a proprietary "data confidence" score.
//
// Run locally:   npm install && npm start
// Env required:  RENTCAST_API_KEY (see .env.example)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_FROM_EMAIL = process.env.ALERT_FROM_EMAIL || 'Plumbline Alerts <onboarding@resend.dev>';
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
    countyUnitCount: record.features && record.features.unitCount ? record.features.unitCount : null
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

// ---- ALERTS: subscriptions and evaluation ----
// Stored in memory for now — swap for a real database before relying on this for real users,
// same caveat as the waitlist above.
const alertSubscriptions = new Map(); // email -> { properties: [...], lastKnownState: { [propertyId]: {...} } }

function monthlyDebtServiceCalc(loanAmount, aprPct, termYears){
  if(!loanAmount || loanAmount <= 0) return 0;
  const r = (aprPct/100)/12;
  const n = termYears*12;
  if(r === 0) return loanAmount/n;
  return loanAmount * (r*Math.pow(1+r,n)) / (Math.pow(1+r,n)-1);
}
function evaluatePropertyFinancials(p){
  const monthlyExpenses = num(p.monthlyTaxes)+num(p.monthlyInsurance)+num(p.monthlyMaintenance)+num(p.monthlyMgmtFee)+num(p.monthlyOtherExpenses);
  const noi = (num(p.monthlyRentActual)*12) - (monthlyExpenses*12);
  const annualDebt = monthlyDebtServiceCalc(num(p.loanAmount), num(p.interestRatePct), num(p.loanTermYears)||30) * 12;
  const dscr = annualDebt > 0 ? noi/annualDebt : null;
  return { noi, dscr, cashFlow: noi - annualDebt };
}

async function evaluateAlertsForProperty(p, lastKnown){
  const alerts = [];
  try{
    const rcType = (p.type === 'Duplex' || p.type === 'Small multifamily') ? 'Multi-Family' : (p.type === 'Single-family' ? 'Single Family' : '');
    const extraParams = rcType ? { propertyType: rcType } : {};
    const rentRaw = await fetchRentcast('avm/rent/long-term', p.address, extraParams);
    const shaped = shapeEstimate(rentRaw, true, p.units || 1);
    if(shaped && shaped.confidence !== null && shaped.confidence >= 35){
      const gap = shaped.estimate - num(p.monthlyRentActual);
      if(gap > 50){
        alerts.push(`Rent may be under market by about $${Math.round(gap)}/mo at ${p.address}.`);
      }
      if(lastKnown.confidence !== undefined && shaped.confidence - lastKnown.confidence >= 20){
        alerts.push(`Market data confidence for ${p.address} improved to ${shaped.confidence}/100 (was ${lastKnown.confidence}) — worth revisiting this estimate.`);
      }
      lastKnown.marketRent = shaped.estimate;
      lastKnown.confidence = shaped.confidence;
    }
  }catch(e){ /* one property's data hiccup shouldn't block the rest of the check */ }

  const fin = evaluatePropertyFinancials(p);
  if(fin.dscr !== null && fin.dscr < 1.2){
    alerts.push(`DSCR at ${p.address} is ${fin.dscr.toFixed(2)}x, below the 1.2x lenders typically want.`);
  }
  if(p.leaseExpiration){
    const days = (new Date(p.leaseExpiration) - new Date()) / 86400000;
    if(days >= 0 && days <= 30){
      alerts.push(`Lease at ${p.address} expires in ${Math.round(days)} days.`);
    }
  }
  return alerts;
}

async function sendAlertEmail(toEmail, alerts){
  if(!RESEND_API_KEY){
    console.log(`[alerts] RESEND_API_KEY not set — would have emailed ${toEmail}:`, alerts);
    return false;
  }
  const html = `<p>Here's what needs attention in your Plumbline portfolio:</p><ul>${alerts.map(a => `<li>${a}</li>`).join('')}</ul>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: ALERT_FROM_EMAIL, to: toEmail, subject: 'Plumbline: portfolio alerts', html })
  });
  return res.ok;
}

// ---- routes ----
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/alerts/subscribe', (req, res) => {
  const { email, properties } = req.body || {};
  if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' });
  if(!Array.isArray(properties)) return res.status(400).json({ error: 'properties must be an array' });
  const existing = alertSubscriptions.get(email);
  alertSubscriptions.set(email, { properties, lastKnownState: existing ? existing.lastKnownState : {} });
  res.json({ ok: true, propertyCount: properties.length });
});

app.post('/api/alerts/check-now', async (req, res) => {
  const { email } = req.body || {};
  const sub = alertSubscriptions.get(email);
  if(!sub) return res.status(404).json({ error: 'No subscription found for that email — enable alerts first.' });
  const allAlerts = [];
  for(const p of sub.properties){
    const lastKnown = sub.lastKnownState[p.id] || (sub.lastKnownState[p.id] = {});
    const alerts = await evaluateAlertsForProperty(p, lastKnown);
    allAlerts.push(...alerts);
  }
  let emailSent = false;
  if(allAlerts.length){ emailSent = await sendAlertEmail(email, allAlerts); }
  res.json({ ok: true, alertCount: allAlerts.length, alerts: allAlerts, emailSent });
});

// Daily check for every subscribed email — runs at 13:00 UTC (~8am ET) regardless of whether anyone has the dashboard open.
cron.schedule('0 13 * * *', async () => {
  for(const [email, sub] of alertSubscriptions.entries()){
    const allAlerts = [];
    for(const p of sub.properties){
      const lastKnown = sub.lastKnownState[p.id] || (sub.lastKnownState[p.id] = {});
      try{
        allAlerts.push(...(await evaluateAlertsForProperty(p, lastKnown)));
      }catch(e){ console.error('[alerts] check failed for', p.address, e.message); }
    }
    if(allAlerts.length){
      try{ await sendAlertEmail(email, allAlerts); }
      catch(e){ console.error('[alerts] email send failed for', email, e.message); }
    }
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
