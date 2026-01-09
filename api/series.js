import { Redis } from "@upstash/redis";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// 19 сек раунд: 7 сек ставки + 12 сек игра
const BET_MS = 7000;
const PLAY_MS = 12000;
const ROUND_MS = BET_MS + PLAY_MS;

const SERIES_KEY = "chart:series_pct";   // JSON [[ts, pct], ...]
const LAST_PCT_KEY = "chart:lastPct";    // string pct
const LOCK_PREFIX = "chart:tick:";       // lock per second

function rand(min, max) {
  return min + Math.random() * (max - min);
}
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

// round helpers
function roundIdByTs(ts) {
  return Math.floor(ts / ROUND_MS);
}
function roundStartAt(roundId) {
  return roundId * ROUND_MS;
}
function roundEndAt(roundId) {
  return roundStartAt(roundId) + ROUND_MS;
}

async function ensureRoundStart(roundId) {
  const k = `round:startPct:${roundId}`;
  const exists = await redis.get(k);
  if (exists) return Number(exists);
  const last = Number(await redis.get(LAST_PCT_KEY));
  const v = Number.isFinite(last) ? last : 0;
  await redis.set(k, String(v), { ex: 24 * 60 * 60 });
  return v;
}

async function finalizeRoundIfNeeded(roundId) {
  // если уже финализирован — выходим
  const endKey = `round:endPct:${roundId}`;
  const done = await redis.get(endKey);
  if (done) return;

  const now = Date.now();
  if (now < roundEndAt(roundId)) return; // раунд ещё не закончился

  const startPct = Number(await redis.get(`round:startPct:${roundId}`));
  const endPct = Number(await redis.get(LAST_PCT_KEY));
  if (!Number.isFinite(startPct) || !Number.isFinite(endPct)) return;

  // результат раунда = endPct - startPct (в процентах)
  let resultPct = endPct - startPct;
  resultPct = clamp(resultPct, -100, 100);

  await redis.set(endKey, String(resultPct), { ex: 24 * 60 * 60 });

  const item = {
    roundId,
    pct: Number(resultPct.toFixed(0)),
    ts: now
  };

  // пушим в историю (свежие сверху)
  await redis.lpush("round:history", JSON.stringify(item));
  await redis.ltrim("round:history", 0, 17);
  await redis.expire("round:history", 24 * 60 * 60);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "GET") return res.status(405).json({ error: "method" });

    const now = Date.now();

    // загрузка series
    let series = [];
    const raw = await redis.get(SERIES_KEY);
    if (typeof raw === "string" && raw) {
      try { series = JSON.parse(raw); } catch { series = []; }
    }

    // стартовая инициализация
    let lastPct = Number(await redis.get(LAST_PCT_KEY));
    if (!Number.isFinite(lastPct)) lastPct = 0;

    if (!Array.isArray(series) || series.length === 0) {
      series = [];
      let p = lastPct;

      // создаём ~90 секунд истории
      for (let i = 90; i >= 1; i--) {
        p = clamp(p + rand(-1.6, 1.6), -100, 100);
        series.push([now - i * 1000, Number(p.toFixed(2))]);
      }

      lastPct = series[series.length - 1][1];
      await redis.set(SERIES_KEY, JSON.stringify(series), { ex: 60 * 60 });
      await redis.set(LAST_PCT_KEY, String(lastPct), { ex: 60 * 60 });

      // фиксируем старт текущего раунда
      await ensureRoundStart(roundIdByTs(now));

      return res.status(200).json({ serverNow: now, series });
    }

    // 1 раз в секунду добавляем точку (lock)
    const sec = Math.floor(now / 1000);
    const lockKey = `${LOCK_PREFIX}${sec}`;
    const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 5 });

    if (gotLock) {
      const lastTs = series[series.length - 1][0];

      if (now - lastTs >= 900) {
        // движение процента (гладко)
        const prev = Number(series[series.length - 1][1]);
        lastPct = clamp(prev + rand(-2.2, 2.2), -100, 100);

        series.push([now, Number(lastPct.toFixed(2))]);
        if (series.length > 240) series = series.slice(-240);

        await redis.set(SERIES_KEY, JSON.stringify(series), { ex: 60 * 60 });
        await redis.set(LAST_PCT_KEY, String(lastPct), { ex: 60 * 60 });

        // если начался новый раунд — зафиксируем старт
        const rid = roundIdByTs(now);
        await ensureRoundStart(rid);

        // попробуем финализировать прошлый раунд
        await finalizeRoundIfNeeded(rid - 1);
      }
    }

    // отдаём актуальную серию
    const raw2 = await redis.get(SERIES_KEY);
    if (typeof raw2 === "string" && raw2) {
      try { series = JSON.parse(raw2); } catch {}
    }

    return res.status(200).json({ serverNow: now, series });
  } catch (e) {
    return res.status(500).json({ error: "series_error", message: String(e) });
  }
}
