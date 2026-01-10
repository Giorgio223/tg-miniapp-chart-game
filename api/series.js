import { Redis } from "@upstash/redis";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// 7 секунд ставки + 12 секунд игра
export const BET_MS = 7000;
export const PLAY_MS = 12000;
export const ROUND_MS = BET_MS + PLAY_MS;

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

// детерминированный RNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// генерация “как нитка”: мягкая случайная линия с режимами (тренд/флэт/волатильность)
function genRoundSeries(roundId, nowMs) {
  const start = roundStartAt(roundId);
  const end = start + ROUND_MS;

  // точка каждые 250мс — плавнее, но не жрёт трафик как 60fps
  const stepMs = 250;

  const rng = mulberry32(roundId * 1000003 + 1337);

  let v = 0;
  let drift = 0;          // тренд
  let vol = 0.35;         // волатильность

  let nextRegimeAt = start;

  const out = [];
  for (let t = start; t <= Math.min(nowMs, end); t += stepMs) {
    // каждые ~2-4 секунды меняем режим
    if (t >= nextRegimeAt) {
      const mode = rng();
      if (mode < 0.45) {
        // флет
        drift = (rng() * 0.10 - 0.05);
        vol = 0.22 + rng() * 0.18;
      } else if (mode < 0.85) {
        // тренд
        drift = (rng() < 0.5 ? -1 : 1) * (0.06 + rng() * 0.14);
        vol = 0.18 + rng() * 0.22;
      } else {
        // всплеск (интрига)
        drift = (rng() * 0.16 - 0.08);
        vol = 0.45 + rng() * 0.40;
      }
      nextRegimeAt = t + (2000 + Math.floor(rng() * 2000));
    }

    // шум + волна
    const noise = (rng() * 2 - 1) * vol;
    const wave = Math.sin((t - start) / 1400) * 0.22 + Math.sin((t - start) / 4200) * 0.14;

    // мягкая “инерция”, чтобы не пилило
    v = v + drift + noise + wave;
    v *= 0.995;

    // диапазон как у слотов на скрине (примерно): не улетать в -100/+100 постоянно
    v = clamp(v, -35, 60);

    out.push([t, v]);
  }

  if (!out.length) out.push([start, 0]);
  return out;
}

// финализация раунда => сохраняем результат в redis + историю
async function finalizeRoundIfEnded(roundId) {
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

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");

    const now = Date.now();
    const rid = roundIdByNow(now);

    // важно: финализируем прошлые раунды и тут тоже
    await finalizeRoundIfEnded(rid - 1);
    await finalizeRoundIfEnded(rid - 2);

    const series = genRoundSeries(rid, now);
    return res.status(200).json({ ok: true, series });
  } catch (e) {
    return res.status(500).json({ error: "series_error", message: String(e) });
  }
}
