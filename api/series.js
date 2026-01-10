const { Redis } = require("@upstash/redis");

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
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function getRedisSafe() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// детерминированный RNG (чтобы у всех пользователей был один и тот же график)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// “нитка/волны”: режимы тренд/флет/волатильность без дерготни
function genRoundSeries(roundId, nowMs) {
  const start = roundStartAt(roundId);
  const end = start + ROUND_MS;

  const stepMs = 250; // плавно, но не перегружает

  const rng = mulberry32(roundId * 1000003 + 1337);

  let v = 0;
  let drift = 0;
  let vol = 0.35;

  let nextRegimeAt = start;

  const out = [];
  for (let t = start; t <= Math.min(nowMs, end); t += stepMs) {
    if (t >= nextRegimeAt) {
      const mode = rng();
      if (mode < 0.45) {
        drift = (rng() * 0.10 - 0.05);
        vol = 0.22 + rng() * 0.18;
      } else if (mode < 0.85) {
        drift = (rng() < 0.5 ? -1 : 1) * (0.06 + rng() * 0.14);
        vol = 0.18 + rng() * 0.22;
      } else {
        drift = (rng() * 0.16 - 0.08);
        vol = 0.45 + rng() * 0.40;
      }
      nextRegimeAt = t + (2000 + Math.floor(rng() * 2000));
    }

    const noise = (rng() * 2 - 1) * vol;
    const wave = Math.sin((t - start) / 1400) * 0.22 + Math.sin((t - start) / 4200) * 0.14;

    v = v + drift + noise + wave;
    v *= 0.995;

    // диапазон “как на скрине”, без вечных -100/+100
    v = clamp(v, -35, 60);

    out.push([t, v]);
  }

  if (!out.length) out.push([start, 0]);
  return out;
}

async function finalizeRoundIfEnded(redis, roundId) {
  if (!redis) return;
  if (roundId < 0) return;

  const endAt = roundStartAt(roundId) + ROUND_MS;
  if (Date.now() < endAt) return;

  const key = `round:endPct:${roundId}`;
  const exists = await redis.get(key);
  if (exists != null) return;

  const series = genRoundSeries(roundId, endAt);
  const last = series[series.length - 1];
  const endPct = Math.round(Number(last?.[1] || 0));

  await redis.set(key, String(endPct));

  const item = JSON.stringify({ roundId, pct: endPct, ts: endAt });
  await redis.lpush(HISTORY_KEY, item);
  await redis.ltrim(HISTORY_KEY, 0, 49);
}

module.exports = async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");

    const now = Date.now();
    const rid = roundIdByNow(now);

    const redis = getRedisSafe();

    // финализируем прошлые раунды, чтобы история стабильно копилась
    await finalizeRoundIfEnded(redis, rid - 1);
    await finalizeRoundIfEnded(redis, rid - 2);

    const series = genRoundSeries(rid, now);
    return res.status(200).json({ ok: true, series });
  } catch (e) {
    return res.status(500).json({
      error: "series_error",
      message: String(e && (e.stack || e.message || e))
    });
  }
};
