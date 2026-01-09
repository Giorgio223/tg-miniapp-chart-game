import { Redis } from "@upstash/redis";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const SERIES_KEY = "chart:series";       // JSON: [[ts, price], ...]
const LAST_PRICE_KEY = "chart:lastPrice"; // string price

function rand(min, max) {
  return min + Math.random() * (max - min);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "GET") return res.status(405).json({ error: "method" });

    const now = Date.now();

    let seriesRaw = await redis.get(SERIES_KEY);
    let series = [];
    if (typeof seriesRaw === "string" && seriesRaw) {
      try { series = JSON.parse(seriesRaw); } catch { series = []; }
    }

    let lastPrice = Number(await redis.get(LAST_PRICE_KEY));
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
      lastPrice = 100 + rand(-1, 1);
    }

    // если series пустой — создаём стартовые точки
    if (!Array.isArray(series) || series.length === 0) {
      series = [];
      let p = lastPrice;
      for (let i = 80; i >= 1; i--) {
        p += rand(-0.35, 0.35);
        series.push([now - i * 1000, Number(p.toFixed(4))]);
      }
      lastPrice = series[series.length - 1][1];
    } else {
      const lastTs = series[series.length - 1][0];
      // добавляем по 1 точке раз в ~1с
      if (now - lastTs >= 900) {
        // небольшой “дрейф”
        lastPrice = lastPrice + rand(-0.35, 0.35);
        series.push([now, Number(lastPrice.toFixed(4))]);
        // храним последние 200 точек
        if (series.length > 200) series = series.slice(-200);
      } else {
        // синхроним lastPrice с последней точкой
        lastPrice = Number(series[series.length - 1][1]);
      }
    }

    await redis.set(SERIES_KEY, JSON.stringify(series), { ex: 60 * 60 });
    await redis.set(LAST_PRICE_KEY, String(lastPrice), { ex: 60 * 60 });

    return res.status(200).json({ serverNow: now, series });
  } catch (e) {
    return res.status(500).json({ error: "series_error", message: String(e) });
  }
}
