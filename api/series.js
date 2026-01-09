import { Redis } from "@upstash/redis";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const SERIES_KEY = "chart:series";        // JSON [[ts, price], ...]
const LAST_PRICE_KEY = "chart:lastPrice"; // string
const LOCK_PREFIX = "chart:tick:";        // lock per second

function rand(min, max) {
  return min + Math.random() * (max - min);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "GET") return res.status(405).json({ error: "method" });

    const now = Date.now();

    // грузим series
    let series = [];
    const raw = await redis.get(SERIES_KEY);
    if (typeof raw === "string" && raw) {
      try { series = JSON.parse(raw); } catch { series = []; }
    }

    // стартовая генерация
    let lastPrice = Number(await redis.get(LAST_PRICE_KEY));
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) lastPrice = 100 + rand(-1, 1);

    if (!Array.isArray(series) || series.length === 0) {
      series = [];
      let p = lastPrice;
      for (let i = 80; i >= 1; i--) {
        p += rand(-0.35, 0.35);
        series.push([now - i * 1000, Number(p.toFixed(4))]);
      }
      lastPrice = series[series.length - 1][1];
      await redis.set(SERIES_KEY, JSON.stringify(series), { ex: 60 * 60 });
      await redis.set(LAST_PRICE_KEY, String(lastPrice), { ex: 60 * 60 });
      return res.status(200).json({ serverNow: now, series });
    }

    // добавляем точки строго 1 раз в секунду (lock на текущую секунду)
    const sec = Math.floor(now / 1000);
    const lockKey = `${LOCK_PREFIX}${sec}`;
    const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 5 });

    if (gotLock) {
      const lastTs = series[series.length - 1][0];
      // если реально пора — добавим
      if (now - lastTs >= 900) {
        lastPrice = Number(series[series.length - 1][1]) + rand(-0.35, 0.35);
        series.push([now, Number(lastPrice.toFixed(4))]);
        if (series.length > 240) series = series.slice(-240);

        await redis.set(SERIES_KEY, JSON.stringify(series), { ex: 60 * 60 });
        await redis.set(LAST_PRICE_KEY, String(lastPrice), { ex: 60 * 60 });
      }
    }

    // отдаём текущее
    const raw2 = await redis.get(SERIES_KEY);
    let series2 = series;
    if (typeof raw2 === "string" && raw2) {
      try { series2 = JSON.parse(raw2); } catch {}
    }

    return res.status(200).json({ serverNow: now, series: series2 });
  } catch (e) {
    return res.status(500).json({ error: "series_error", message: String(e) });
  }
}
