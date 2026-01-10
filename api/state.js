const { Redis } = require("@upstash/redis");

module.exports.config = { runtime: "nodejs" };

const BET_MS = 7000;
const PLAY_MS = 12000;
const ROUND_MS = BET_MS + PLAY_MS;

const HISTORY_KEY = "round:history"; // list of json strings latest first
const HISTORY_MAX = 50;

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash env missing: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");
  return new Redis({ url, token });
}

function roundIdByNow(nowMs) {
  return Math.floor(nowMs / ROUND_MS);
}
function roundStartAt(roundId) {
  return roundId * ROUND_MS;
}
function roundEndAt(roundId) {
  return roundStartAt(roundId) + ROUND_MS;
}
function phaseByNow(nowMs) {
  const rid = roundIdByNow(nowMs);
  const start = roundStartAt(rid);
  const t = nowMs - start;
  const phase = (t < BET_MS) ? "BET" : "PLAY";
  const phaseEndsAt = start + ((phase === "BET") ? BET_MS : ROUND_MS);
  return { rid, start, phase, phaseEndsAt };
}

// распределение результата (endPct)
function pickEndPctByRoundId(roundId) {
  // детерминированный псевдорандом
  let x = (roundId * 1103515245 + 12345) >>> 0;
  function rnd() {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  }

  // 50% SHORT: 0..-100
  // 50% LONG: 0..50 (40%), 50..100 (5%), 100..150 (3%), 150..200 (2%)
  const r = rnd();

  if (r < 0.50) {
    // SHORT
    const u = rnd();
    const val = -(u * 100); // 0..-100
    return Number(val.toFixed(4));
  }

  // LONG
  const r2 = (r - 0.50) / 0.50; // 0..1 inside LONG block
  const u = rnd();

  if (r2 < 0.80) {
    // 40% of total -> 0..50
    return Number((u * 50).toFixed(4));
  } else if (r2 < 0.90) {
    // 5% of total -> 50..100
    return Number((50 + u * 50).toFixed(4));
  } else if (r2 < 0.96) {
    // 3% of total -> 100..150
    return Number((100 + u * 50).toFixed(4));
  } else {
    // 2% of total -> 150..200
    return Number((150 + u * 50).toFixed(4));
  }
}

async function ensureEndPct(redis, roundId) {
  const key = `round:endPct:${roundId}`;
  const existing = await redis.get(key);
  if (typeof existing === "number") return existing;
  if (typeof existing === "string") {
    const n = Number(existing);
    if (isFinite(n)) return n;
  }
  const endPct = pickEndPctByRoundId(roundId);
  await redis.set(key, String(endPct));
  return endPct;
}

async function finalizeRound(redis, roundId) {
  if (roundId < 0) return;

  const now = Date.now();
  const endAt = roundEndAt(roundId);
  if (now < endAt) return; // ещё не закончился

  const finalizedKey = `round:finalized:${roundId}`;
  const already = await redis.get(finalizedKey);
  if (already) return;

  const endPct = await ensureEndPct(redis, roundId);
  const winSide = (endPct >= 0) ? "LONG" : "SHORT";

  const item = {
    roundId,
    endPct,
    winSide,
    startAt: roundStartAt(roundId),
    endAt,
    endedAt: endAt
  };

  await redis.lpush(HISTORY_KEY, JSON.stringify(item));
  await redis.ltrim(HISTORY_KEY, 0, HISTORY_MAX - 1);
  await redis.set(finalizedKey, "1");
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function getTotals(redis, roundId) {
  const key = `round:betTotals:${roundId}`;
  const h = await redis.hgetall(key);
  // Upstash может вернуть null
  const longAmount  = Number(h?.longAmount  || 0);
  const shortAmount = Number(h?.shortAmount || 0);
  return {
    longAmount:  isFinite(longAmount) ? longAmount : 0,
    shortAmount: isFinite(shortAmount) ? shortAmount : 0
  };
}

module.exports = async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");

    const redis = getRedis();
    const now = Date.now();

    const { rid, start, phase, phaseEndsAt } = phaseByNow(now);
    const endAt = roundEndAt(rid);
    const nextAt = roundStartAt(rid + 1);

    // финализируем несколько предыдущих раундов на всякий случай
    await finalizeRound(redis, rid - 1);
    await finalizeRound(redis, rid - 2);
    await finalizeRound(redis, rid - 3);

    // история из upstash
    const raw = await redis.lrange(HISTORY_KEY, 0, HISTORY_MAX - 1);
    const history = (raw || []).map(safeJson).filter(Boolean);

    const currentTotals = await getTotals(redis, rid);

    return res.status(200).json({
      ok: true,
      serverNow: now,
      betMs: BET_MS,
      playMs: PLAY_MS,
      roundMs: ROUND_MS,
      phase,
      phaseEndsAt,
      round: { roundId: rid, startAt: start, endAt, nextAt },
      currentTotals,
      history
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "state_error",
      message: String(e && (e.stack || e.message || e))
    });
  }
};
