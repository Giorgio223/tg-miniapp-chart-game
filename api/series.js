const { Redis } = require("@upstash/redis");
module.exports.config = { runtime: "nodejs" };

const BET_MS = 7000;
const PLAY_MS = 12000;
const ROUND_MS = BET_MS + PLAY_MS;

const END_PCT_KEY = (rid) => `round:endPct:${rid}`;

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");
  return new Redis({ url, token });
}

function roundIdByNow(nowMs) {
  return Math.floor(nowMs / ROUND_MS);
}
function roundStartAt(roundId) {
  return roundId * ROUND_MS;
}
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

// детерминированный rng для “волатильности” формы (НЕ для финала)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Генератор волатильной серии с гарантированным финалом endPct
function genRoundSeries(roundId, nowMs, endPct) {
  const start = roundStartAt(roundId);
  const end = start + ROUND_MS;

  const stepMs = 200; // чем больше — тем медленнее “рисование”
  const rng = mulberry32(roundId * 1000003 + 2025);

  const out = [];

  const MIN = -110;
  const MAX = 210;

  let v = 0;
  let vel = 0;

  // режимы каждые 1.6–3.8 сек
  let nextRegimeAt = start;
  let vol = 2.0;
  let drift = 0.0;

  for (let t = start; t <= Math.min(nowMs, end); t += stepMs) {
    if (t >= nextRegimeAt) {
      const m = rng();
      if (m < 0.40) {
        vol = 1.3 + rng() * 1.8;
        drift = (rng() * 0.30 - 0.15);
      } else if (m < 0.80) {
        vol = 2.2 + rng() * 2.8;
        drift = (rng() < 0.5 ? -1 : 1) * (0.05 + rng() * 0.45);
      } else {
        vol = 3.8 + rng() * 4.5;
        drift = (rng() * 0.60 - 0.30);
      }
      nextRegimeAt = t + (1600 + Math.floor(rng() * 2200));
    }

    const p = clamp((t - start) / ROUND_MS, 0, 1);

    const anchor =
      endPct * p +
      Math.sin((t - start) / 820) * (1.8 + vol * 0.30) +
      Math.sin((t - start) / 2400) * (1.2 + vol * 0.18);

    const pull = (anchor - v) * (0.05 + p * 0.02);

    const noise = (rng() * 2 - 1) * vol;
    const jerk = (rng() < 0.02 ? (rng() * 2 - 1) * (2.0 + vol) : 0); // редкие рывки

    vel = (vel + pull + drift + noise + jerk) * 0.86;
    v = v + vel;

    // перед концом точнее загоняем в endPct
    if (end - t <= 1000) {
      v = v + (endPct - v) * 0.28;
    }

    v = clamp(v, MIN, MAX);
    out.push([t, v]);
  }

  if (!out.length) out.push([start, 0]);

  if (nowMs >= end) out.push([end, endPct]);

  return out;
}

module.exports = async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");

    const redis = getRedis();
    const now = Date.now();
    const rid = roundIdByNow(now);

    // endPct должен быть общий (из Upstash), чтобы совпало с history/state
    const endPctRaw = await redis.get(END_PCT_KEY(rid));
    const endPct = endPctRaw != null ? Number(endPctRaw) : 0;

    const series = genRoundSeries(rid, now, endPct);

    return res.status(200).json({
      ok: true,
      roundId: rid,
      endPct,
      series
    });
  } catch (e) {
    return res.status(500).json({
      error: "series_error",
      message: String(e && (e.stack || e.message || e))
    });
  }
};
