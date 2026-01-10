const { Redis } = require("@upstash/redis");

module.exports.config = { runtime: "nodejs" };

const BET_MS = 7000;
const PLAY_MS = 12000;
const ROUND_MS = BET_MS + PLAY_MS;

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

// детерминированный random от roundId
function seededRng(seed) {
  let x = (seed * 1103515245 + 12345) >>> 0;
  return function rnd() {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

// endPct distribution (same as state.js)
function pickEndPctByRoundId(roundId) {
  const rnd = seededRng(roundId);
  const r = rnd();

  if (r < 0.50) {
    const u = rnd();
    return Number((-(u * 100)).toFixed(4)); // 0..-100
  }

  const r2 = (r - 0.50) / 0.50; // 0..1
  const u = rnd();

  if (r2 < 0.80) return Number((u * 50).toFixed(4));          // 0..50
  if (r2 < 0.90) return Number((50 + u * 50).toFixed(4));      // 50..100
  if (r2 < 0.96) return Number((100 + u * 50).toFixed(4));     // 100..150
  return Number((150 + u * 50).toFixed(4));                    // 150..200
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

// волатильная серия: медленно, но с редкими рывками
function genSeries(roundId, nowMs, endPct) {
  const rnd = seededRng(roundId ^ 0xA5A5A5A5);

  const startAt = roundStartAt(roundId);
  const endAt = roundEndAt(roundId);

  // количество точек — много, но рисовать будем медленно на фронте
  const points = 260;

  // базовая шкала "процентов" (value)
  let v = 0;

  // target end
  const target = endPct;

  // волатильность: маленький шум + редкие джерки
  const baseNoise = 0.22 + rnd() * 0.15; // 0.22..0.37
  const jerkChance = 0.035;             // шанс рывка на шаг
  const jerkMin = 1.8;
  const jerkMax = 5.5;

  const series = [];
  for (let i = 0; i < points; i++) {
    const t = startAt + Math.floor((i / (points - 1)) * (endAt - startAt));
    const progress = i / (points - 1);

    // шум
    let step = (rnd() - 0.5) * baseNoise;

    // рывок иногда
    if (rnd() < jerkChance) {
      const dir = rnd() < 0.5 ? -1 : 1;
      const mag = jerkMin + rnd() * (jerkMax - jerkMin);
      step += dir * mag;
    }

    // притяжение к финалу (чтобы точно прийти к target)
    // чем ближе к концу — тем сильнее
    const pull = (target - v) * (0.015 + progress * 0.055);
    v = v + step + pull;

    // последняя точка строго равна target
    if (i === points - 1) v = target;

    series.push({
      time: Math.floor(t / 1000), // lightweight-charts ждёт seconds
      value: Number(v.toFixed(4))
    });
  }

  return series;
}

module.exports = async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");

    const redis = getRedis();
    const now = Date.now();

    const requested = req.query && req.query.roundId ? Number(req.query.roundId) : null;
    const roundId = Number.isFinite(requested) ? requested : roundIdByNow(now);

    const endPct = await ensureEndPct(redis, roundId);
    const series = genSeries(roundId, now, endPct);

    return res.status(200).json({ ok: true, roundId, endPct, series });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "series_error",
      message: String(e && (e.stack || e.message || e))
    });
  }
};
