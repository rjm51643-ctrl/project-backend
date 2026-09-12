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
async function fetchRentcast(path, address) {
  if (!RENTCAST_API_KEY) throw new Error('Server is missing RENTCAST_API_KEY');
  const url = `https://api.rentcast.io/v1/${path}?address=${encodeURIComponent(address)}`;
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

function shapeEstimate(raw, isRent) {
  if (!raw) return null;
  return {
    estimate: isRent ? raw.rent : raw.price,
    low: isRent ? raw.rentRangeLow : raw.priceRangeLow,
    high: isRent ? raw.rentRangeHigh : raw.priceRangeHigh,
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
  if (!address) return res.status(400).json({ error: 'address query param is required' });

  const cacheKey = address.toLowerCase();
  const cached = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const [valueRes, rentRes] = await Promise.allSettled([
    fetchRentcast('avm/value', address),
    fetchRentcast('avm/rent/long-term', address)
  ]);

  const result = {
    address,
    cached: false,
    value: valueRes.status === 'fulfilled' ? shapeEstimate(valueRes.value, false) : null,
    rent: rentRes.status === 'fulfilled' ? shapeEstimate(rentRes.value, true) : null,
    errors: {
      value: valueRes.status === 'rejected' ? valueRes.reason.message : null,
      rent: rentRes.status === 'rejected' ? rentRes.reason.message : null
    }
  };

  if (result.value || result.rent) setCached(cacheKey, result);
  res.json(result);
});

app.listen(PORT, () => console.log(`Plumbline backend listening on port ${PORT}`));
