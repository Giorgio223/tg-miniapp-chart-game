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

function roundIdByNow(nowMs) { return Math.floor(nowMs / ROUND_MS); }
function roundStartAt(roundId) { return roundId * ROUND_MS; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genRoundSeries(roundId, nowMs, endPct) {
  const start = roundStartAt(roundId);
  const end = start + ROUND_MS;

  // IMPORTANT: время отдаём В МИЛЛИСЕКУНДАХ как и раньше, фронт сам сконвертит
  const stepMs = 220; // медленнее, меньше лагов
  const rng = mulberry32(roundId * 1000003 + 2025);

  const out = [];
  const MIN = -110;
  const MAX = 210;

  let v = 0;
  let vel = 0;

  let nextRegimeAt = start;
  let vol = 1.6;
  let drift = 0.0;

  for (let t = start; t <= Math.min(nowMs, end); t += stepMs) {
    if (t >= nextRegimeAt) {
      const m = rng();
      // больше “гор/рек”, меньше “дребезга”
      if (m < 0.35) { vol = 1.2 + rng() * 1.2; drift = (rng()*0.20 - 0.10); }
      else if (m < 0.80) { vol = 2.0 + rng() * 2.2; drift = (rng()<0.5?-1:1)*(0.08 + rng()*0.30); }
      else { vol = 3.0 + rng() * 3.5; drift = (rng()*0.35 - 0.175); }

      nextRegimeAt = t + (1800 + Math.floor(rng() * 2600));
    }

    const p = clamp((t - start) / ROUND_MS, 0, 1);

    const longWave =
      Math.sin((t - start) / 1800) * (3.0 + vol * 0.45) +
      Math.sin((t - start) / 5200) * (4.5 + vol * 0.55);

    // плавная “река” к финалу
    const anchor = endPct * p + longWave;

    const pull = (anchor - v) * (0.045 + p * 0.030);

    // шум уменьшен
    const noise = (rng() * 2 - 1) * (vol * 0.45);

    // редкие рывки (азарт)
    const jerk = (rng() < 0.012 ? (rng()*2-1) * (2.2 + vol*1.3) : 0);

    vel = (vel + pull + drift + noise + jerk) * 0.88;
    v = v + vel;

    // в конце точно дожимаем к endPct
    if (end - t <= 1200) v = v + (endPct - v) * 0.30;

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

    // ВАЖНО: roundId берём либо из query, либо текущий
    const q = req.query || {};
    const ridQ = Number(q.roundId);
    const roundId = Number.isFinite(ridQ) ? ridQ : roundIdByNow(now);

    const endPctRaw = await redis.get(END_PCT_KEY(roundId));
    const endPct = endPctRaw != null ? Number(endPctRaw) : 0;

    const series = genRoundSeries(roundId, now, endPct);

    return res.status(200).json({
      ok: true,
      roundId,
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
