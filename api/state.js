const { Redis } = require("@upstash/redis");
module.exports.config = { runtime: "nodejs" };

const BET_MS = 7000;
const PLAY_MS = 12000;
const ROUND_MS = BET_MS + PLAY_MS;

const HISTORY_KEY = "round:history";               // list newest first: {roundId,pct,ts}
const LAST_FINALIZED_KEY = "round:lastFinalized";  // number
const END_PCT_KEY = (rid) => `round:endPct:${rid}`;

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");
  return new Redis({ url, token });
}

function roundIdByNow(nowMs) { return Math.floor(nowMs / ROUND_MS); }
function roundStartAt(roundId) { return roundId * ROUND_MS; }
function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rngForRound(roundId) {
  const seed = xmur3("round:" + String(roundId))();
  return mulberry32(seed);
}

// SHORT: 0..-100 = 50%
// LONG: 0..50 = 40%, 50..100 = 5%, 100..150 = 3%, 150..200 = 2%
function pickEndPctForRound(roundId) {
  const r = rngForRound(roundId)();

  if (r < 0.50) {
    const u = rngForRound(roundId)();
    return Math.round(clamp(-(u * 100), -100, 0) * 10) / 10;
  }

  const t = (r - 0.50) / 0.50; // 0..1
  const u = rngForRound(roundId)();
  if (t < 0.80) return Math.round((u * 50) * 10) / 10;
  if (t < 0.90) return Math.round((50 + u * 50) * 10) / 10;
  if (t < 0.96) return Math.round((100 + u * 50) * 10) / 10;
  return Math.round((150 + u * 50) * 10) / 10;
}

function safeJson(s){ try{ return JSON.parse(s); } catch { return null; } }

async function ensureEndPct(redis, roundId) {
  const key = END_PCT_KEY(roundId);
  const existing = await redis.get(key);
  if (existing != null) return Number(existing);

  const endPct = pickEndPctForRound(roundId);
  await redis.set(key, String(endPct), { nx: true });
  return endPct;
}

async function finalizeRound(redis, roundId) {
  if (roundId < 0) return;

  const endAt = roundStartAt(roundId) + ROUND_MS;
  if (Date.now() < endAt) return;

  const endPct = await ensureEndPct(redis, roundId);

  const lastArr = await redis.lrange(HISTORY_KEY, 0, 0);
  const last = lastArr?.[0] ? safeJson(lastArr[0]) : null;
  if (last?.roundId === roundId) return;

  const item = JSON.stringify({ roundId, pct: Number(endPct), ts: endAt });
  await redis.lpush(HISTORY_KEY, item);
  await redis.ltrim(HISTORY_KEY, 0, 199);
  await redis.set(LAST_FINALIZED_KEY, String(roundId));
}

module.exports = async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");

    const redis = getRedis();
    const now = Date.now();

    const roundId = roundIdByNow(now);
    const startAt = roundStartAt(roundId);
    const betEndAt = startAt + BET_MS;
    const endAt = startAt + ROUND_MS;

    const phase = now < betEndAt ? "BET" : "PLAY";
    const phaseEndsAt = phase === "BET" ? betEndAt : endAt;

    // создаём финал текущего раунда
    await ensureEndPct(redis, roundId);

    // финализируем пропущенные
    const lastFinalizedRaw = await redis.get(LAST_FINALIZED_KEY);
    let lastFinalized = Number.isFinite(Number(lastFinalizedRaw))
      ? Number(lastFinalizedRaw)
      : (roundId - 6);

    const target = roundId - 1;
    for (let rid = lastFinalized + 1, steps=0; rid <= target && steps < 80; rid++, steps++) {
      await finalizeRound(redis, rid);
    }

    // history последние 10
    const rawHist = await redis.lrange(HISTORY_KEY, 0, 9);
    const history = (rawHist || []).map(safeJson).filter(Boolean);

    return res.status(200).json({
      ok: true,
      serverNow: now,
      phase,
      phaseEndsAt,
      betMs: BET_MS,
      playMs: PLAY_MS,
      roundMs: ROUND_MS,
      treasuryAddress: process.env.TREASURY_TON_ADDRESS || "",
      round: { roundId, startAt, betEndAt, endAt, nextAt: endAt },
      history
    });
  } catch (e) {
    return res.status(500).json({
      error: "state_error",
      message: String(e && (e.stack || e.message || e))
    });
  }
};
