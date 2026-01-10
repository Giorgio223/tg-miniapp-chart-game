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

// детерминированный RNG (чтобы у всех пользователей был один и тот же раунд/результат)
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

// Генератор “волатильной” серии, но с гарантированным финалом (endPct)
function genRoundSeries(roundId, nowMs, endPct) {
  const start = roundStartAt(roundId);
  const end = start + ROUND_MS;

  const stepMs = 200; // чуть чаще — ощущение “азарта”, но не слишком тяжело
  const rng = mulberry32(roundId * 1000003 + 2025);

  const out = [];

  const MIN = -110;
  const MAX = 210;

  let v = 0;
  let vel = 0;

  // режимы волатильности (меняются каждые 1.5–3.5 сек)
  let nextRegimeAt = start;
  let vol = 2.2;     // амплитуда шума
  let drift = 0.0;   // средний уклон

  for (let t = start; t <= Math.min(nowMs, end); t += stepMs) {
    if (t >= nextRegimeAt) {
      const m = rng();
      if (m < 0.35) {
        vol = 1.6 + rng() * 2.2;
        drift = (rng() * 0.40 - 0.20);
      } else if (m < 0.75) {
        vol = 2.4 + rng() * 3.4;
        drift = (rng() < 0.5 ? -1 : 1) * (0.10 + rng() * 0.55);
      } else {
        vol = 4.0 + rng() * 5.0;
        drift = (rng() * 0.70 - 0.35);
      }
      nextRegimeAt = t + (1500 + Math.floor(rng() * 2000));
    }

    const p = clamp((t - start) / ROUND_MS, 0, 1);

    // “якорь” раунда: постепенно тянем к endPct, но добавляем волну, чтобы было живо
    const anchor =
      endPct * p +
      Math.sin((t - start) / 800) * (2.2 + vol * 0.35) +
      Math.sin((t - start) / 2300) * (1.4 + vol * 0.20);

    const pull = (anchor - v) * (0.05 + p * 0.02); // чем ближе к концу — тем сильнее “подтягиваем”

    const noise = (rng() * 2 - 1) * vol;
    const jerk = (rng() * 2 - 1) * 0.8; // мелкая “нервность”

    vel = (vel + pull + drift + noise + jerk) * 0.86;
    v = v + vel;

    // перед самым концом сильнее загоняем в точный endPct
    if (end - t <= 1000) {
      const k = 0.25;
      v = v + (endPct - v) * k;
    }

    v = clamp(v, MIN, MAX);
    out.push([t, v]);
  }

  if (!out.length) out.push([start, 0]);

  // гарантируем точный финал на endAt (для истории/выплаты)
  const endAt = end;
  if (nowMs >= endAt) {
    out.push([endAt, endPct]);
  }

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

  const endPct = pickEndPctForRound(roundId);

  await redis.set(key, String(endPct));

  const item = JSON.stringify({ roundId, pct: Number(endPct), ts: endAt });
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

    // берем endPct (детерминированно), чтобы серия была одинаковая у всех и совпадала с историей
    const endPct = pickEndPctForRound(rid);

    const series = genRoundSeries(rid, now, endPct);
    return res.status(200).json({ ok: true, series, endPct });
  } catch (e) {
    return res.status(500).json({
      error: "series_error",
      message: String(e && (e.stack || e.message || e))
    });
  }
};
