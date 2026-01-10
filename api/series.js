import { Redis } from "@upstash/redis";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BET_MS = 7000;
const PLAY_MS = 12000;
const ROUND_MS = BET_MS + PLAY_MS;

const SERIES_KEY = "chart:series_pct";
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

// простой детерминированный PRNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genRoundSeries(roundId, nowMs) {
  const start = roundStartAt(roundId);
  const endPlay = start + ROUND_MS;
  const rng = mulberry32(roundId * 1000003 + 1337);

  // каждую 1 секунду точка (как раньше)
  const stepMs = 1000;

  let v = 0;
  const out = [];
  for (let t = start; t <= Math.min(nowMs, endPlay); t += stepMs) {
    // шаги +-2.2, и чуть волны
    const step = (rng() * 4.4 - 2.2);
    const wave = Math.sin((t - start) / 1200) * 0.35 + Math.sin((t - start) / 3100) * 0.18;
    v = v + step + wave;
    v = clamp(v, -100, 200);
    out.push([t, v]);
  }

  // гарантируем хотя бы 1 точку
  if (!out.length) out.push([start, 0]);

  return out;
}

async function finalizeIfEnded(roundId) {
  const key = `round:endPct:${roundId}`;
  const exists = await redis.get(key);
  if (exists != null) return;

  const endAt = roundStartAt(roundId) + ROUND_MS;
  if (Date.now() < endAt) return;

  const series = genRoundSeries(roundId, endAt);
  const last = series[series.length - 1];
  const endPct = Math.round(Number(last?.[1] || 0));

  await redis.set(key, String(endPct));

  // пушим в history (LPUSH, потом LTRIM)
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

    // серии для текущего раунда
    const series = genRoundSeries(rid, now);

    // кешируем для дебага (не обязательно, но удобно)
    await redis.set(SERIES_KEY, JSON.stringify(series));

    // финализируем предыдущий раунд, если он закончился
    await finalizeIfEnded(rid - 1);
    // на всякий случай: если сервер долго спал, попробуем ещё
    await finalizeIfEnded(rid - 2);

    return res.status(200).json({ ok: true, series });
  } catch (e) {
    return res.status(500).json({ error: "series_error", message: String(e) });
  }
}
