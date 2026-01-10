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
    endPct = "0";
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
      history
    });
  } catch (e) {
    return res.status(500).json({
      error: "state_error",
      message: String(e && (e.stack || e.message || e))
    });
  }
};
