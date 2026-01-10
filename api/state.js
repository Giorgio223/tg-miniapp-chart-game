const { Redis } = require("@upstash/redis");

// Vercel runtime
module.exports.config = { runtime: "nodejs" };

const BET_MS = 7000;
const PLAY_MS = 12000;
const ROUND_MS = BET_MS + PLAY_MS;

const HISTORY_KEY = "round:history";

function roundIdByNow(nowMs) {
  return Math.floor(nowMs / ROUND_MS);
}
function roundStartAt(roundId) {
  return roundId * ROUND_MS;
}

// Upstash (если env нет — не падаем 500, а возвращаем ok с пустой историей)
function getRedisSafe() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// детерминированный RNG (чтобы распределение было одинаковым для всех)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ✅ РАСПРЕДЕЛЕНИЕ (как ты написал)
// LONG: 0..50 = 40%, 50..100 = 5%, 100..150 = 3%, 150..200 = 2%  (итого 50%)
// SHORT: 0..-100 = 50%
function pickEndPctForRound(roundId) {
  const rng = mulberry32(roundId * 1000003 + 1337);
  const r = rng();

  // SHORT (50%)
  if (r < 0.50) {
    return -Math.round(rng() * 100); // 0..-100
  }

  // LONG (50%) с внутренними весами 0.40/0.05/0.03/0.02
  const x = (r - 0.50) / 0.50; // 0..1
  if (x < 0.80) { // 40% / 50%
    return Math.round(rng() * 50); // 0..50
  } else if (x < 0.90) { // 5% / 50%
    return 50 + Math.round(rng() * 50); // 50..100
  } else if (x < 0.96) { // 3% / 50%
    return 100 + Math.round(rng() * 50); // 100..150
  } else { // 2% / 50%
    return 150 + Math.round(rng() * 50); // 150..200
  }
}

async function finalizeFallback(redis, roundId) {
  if (!redis) return;
  if (roundId < 0) return;

  const endAt = roundStartAt(roundId) + ROUND_MS;
  if (Date.now() < endAt) return;

  const endKey = `round:endPct:${roundId}`;
  let endPct = await redis.get(endKey);

  const lastArr = await redis.lrange(HISTORY_KEY, 0, 0);
  const last = lastArr?.[0] ? safeJson(lastArr[0]) : null;
  if (last?.roundId === roundId) return;

  if (endPct == null) {
    endPct = String(pickEndPctForRound(roundId));
    await redis.set(endKey, endPct);
  }

  const item = JSON.stringify({ roundId, pct: Number(endPct), ts: endAt });
  await redis.lpush(HISTORY_KEY, item);
  await redis.ltrim(HISTORY_KEY, 0, 49);
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");

    const now = Date.now();
    const roundId = roundIdByNow(now);

    const redis = getRedisSafe();

    // финализируем прошлые раунды (чтобы история не пропадала)
    await finalizeFallback(redis, roundId - 1);
    await finalizeFallback(redis, roundId - 2);

    const startAt = roundStartAt(roundId);
    const endAt = startAt + BET_MS;
    const nextAt = startAt + ROUND_MS;

    let history = [];
    if (redis) {
      const rawHist = await redis.lrange(HISTORY_KEY, 0, 9);
      history = (rawHist || []).map(safeJson).filter(Boolean);
    }

    return res.status(200).json({
      ok: true,
      serverNow: now,
      betMs: BET_MS,
      roundMs: ROUND_MS,
      treasuryAddress: process.env.TREASURY_TON_ADDRESS || "",
      round: { roundId, startAt, endAt, nextAt },
      chances: { long: 50, short: 50 },
      history
    });
  } catch (e) {
    return res.status(500).json({
      error: "state_error",
      message: String(e && (e.stack || e.message || e))
    });
  }
};
