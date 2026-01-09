export const config = { runtime: "nodejs" };

import { getRedis } from "../lib/redis.js";
import { BET_MS, ROUND_MS, MIN_Y, MAX_Y, roundIdByNow, clamp } from "../lib/game.js";

const SERIES_KEY = "chart:series";      // JSON [[ts,value],...]
const LAST_PCT_KEY = "chart:lastPct";   // string number
const LOCK_PREFIX = "chart:tick:";      // lock per second

function rand(min, max) {
  return min + Math.random() * (max - min);
}

async function ensureRoundStart(redis, roundId) {
  const key = `round:startPct:${roundId}`;
  const exists = await redis.get(key);
  if (exists != null) return Number(exists);

  const last = Number(await redis.get(LAST_PCT_KEY));
  const v = Number.isFinite(last) ? last : 0;
  await redis.set(key, String(v), { ex: 24 * 60 * 60 });
  return v;
}

async function finalizeRoundIfNeeded(redis, roundId, now) {
  const endKey = `round:endPct:${roundId}`;
  const done = await redis.get(endKey);
  if (done != null) return;

  const roundEnd = roundId * ROUND_MS + ROUND_MS;
  if (now < roundEnd) return;

  const start = Number(await redis.get(`round:startPct:${roundId}`));
  const end = Number(await redis.get(LAST_PCT_KEY));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;

  const pct = clamp(end - start, MIN_Y, MAX_Y);
  await redis.set(endKey, String(pct), { ex: 24 * 60 * 60 });

  // историю делаем совместимую со state.js ниже
  const item = { roundId, pct: Math.round(pct), ts: now };
  await redis.lpush("round:history", JSON.stringify(item));
  await redis.ltrim("round:history", 0, 17);
  await redis.expire("round:history", 24 * 60 * 60);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  let redis;
  try {
    redis = getRedis();
  } catch (e) {
    return res.status(500).json({ error: "redis_init_failed", message: String(e.message || e) });
  }

  try {
    if (req.method !== "GET") return res.status(405).json({ error: "method" });

    const now = Date.now();

    // грузим series
    let series = [];
    const raw = await redis.get(SERIES_KEY);
    if (typeof raw === "string" && raw) {
      try { series = JSON.parse(raw); } catch { series = []; }
    }

    let lastPct = Number(await redis.get(LAST_PCT_KEY));
    if (!Number.isFinite(lastPct)) lastPct = 0;

    // init если пусто
    if (!Array.isArray(series) || series.length === 0) {
      series = [];
      let p = lastPct;

      // 90 секунд истории
      for (let i = 90; i >= 1; i--) {
        p = clamp(p + rand(-1.6, 1.6), MIN_Y, MAX_Y);
        series.push([now - i * 1000, Number(p.toFixed(2))]);
      }

      lastPct = series[series.length - 1][1];
      await redis.set(SERIES_KEY, JSON.stringify(series), { ex: 60 * 60 });
      await redis.set(LAST_PCT_KEY, String(lastPct), { ex: 60 * 60 });

      // зафиксируем старт текущего раунда
      await ensureRoundStart(redis, roundIdByNow(now));

      return res.status(200).json({ serverNow: now, series });
    }

    // раз в секунду добавляем точку (lock)
    const sec = Math.floor(now / 1000);
    const lockKey = `${LOCK_PREFIX}${sec}`;
    const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 5 });

    if (gotLock) {
      const lastTs = Number(series[series.length - 1]?.[0] || 0);

      if (now - lastTs >= 900) {
        const prev = Number(series[series.length - 1]?.[1] || 0);
        lastPct = clamp(prev + rand(-2.2, 2.2), MIN_Y, MAX_Y);

        series.push([now, Number(lastPct.toFixed(2))]);
        if (series.length > 240) series = series.slice(-240);

        await redis.set(SERIES_KEY, JSON.stringify(series), { ex: 60 * 60 });
        await redis.set(LAST_PCT_KEY, String(lastPct), { ex: 60 * 60 });

        const rid = roundIdByNow(now);
        await ensureRoundStart(redis, rid);
        await finalizeRoundIfNeeded(redis, rid - 1, now);
      }
    }

    // отдаём свежую серию
    const raw2 = await redis.get(SERIES_KEY);
    if (typeof raw2 === "string" && raw2) {
      try { series = JSON.parse(raw2); } catch {}
    }

    return res.status(200).json({ serverNow: now, series });
  } catch (e) {
    return res.status(500).json({ error: "series_error", message: String(e) });
  }
}
