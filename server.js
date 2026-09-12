// Plumbline backend — proxies property data lookups, hides API keys server-side,
// caches results, and computes a proprietary "data confidence" score.
//
// Run locally:   npm install && npm start
// Env required:  RENTCAST_API_KEY (see .env.example)

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors()); // tighten this to your real frontend origin before going live
app.use(express.json());

const RENTCAST_API_KEY = process.env.RENTCAST_API_KEY;
const PORT = process.env.PORT || 3000;

// ---- simple in-memory cache (swap for Redis/Postgres once this needs to survive restarts) ----
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours — comps don't move minute to minute
const cache = new Map();

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.timestamp > CACHE_TTL_MS) { cache.delete(key); return null; }
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

// ---- routes ----
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/lookup', async (req, res) => {
  const address = (req.query.address || '').trim();
  const propertyType = (req.query.propertyType || '').trim(); // RentCast enum, e.g. "Multi-Family"
  const squareFootage = req.query.squareFootage ? Number(req.query.squareFootage) : null;
  const units = req.query.units ? Number(req.query.units) : 1;

  if (!address) return res.status(400).json({ error: 'address query param is required' });

  const cacheKey = [address.toLowerCase(), propertyType, squareFootage, units].join('|');
  const cached = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const extraParams = {};
  if (propertyType) extraParams.propertyType = propertyType;
  if (squareFootage) extraParams.squareFootage = squareFootage;

  const [valueRes, rentRes, recordRes] = await Promise.allSettled([
    fetchRentcast('avm/value', address, extraParams),
    fetchRentcast('avm/rent/long-term', address, extraParams),
    fetchRentcastPropertyRecord(address)
  ]);

  const result = {
    address,
    cached: false,
    value: valueRes.status === 'fulfilled' ? shapeEstimate(valueRes.value, false, units) : null,
    rent: rentRes.status === 'fulfilled' ? shapeEstimate(rentRes.value, true, units) : null,
    record: recordRes.status === 'fulfilled' ? shapePropertyRecord(recordRes.value) : null,
    errors: {
      value: valueRes.status === 'rejected' ? valueRes.reason.message : null,
      rent: rentRes.status === 'rejected' ? rentRes.reason.message : null,
      record: recordRes.status === 'rejected' ? recordRes.reason.message : null
    }
  };

  if (result.value || result.rent || result.record) setCached(cacheKey, result);
  res.json(result);
});

app.listen(PORT, () => console.log(`Plumbline backend listening on port ${PORT}`));
