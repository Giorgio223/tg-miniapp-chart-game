import { Redis } from "@upstash/redis";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// тайминги
const BET_MS = 7000;
const PLAY_MS = 12000;
const ROUND_MS = BET_MS + PLAY_MS;

// redis keys
const SERIES_KEY = "chart:series";
const LAST_PCT_KEY = "chart:lastPct";
const LOCK_PREFIX = "chart:tick:";

// utils
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// rounds
const roundIdByTs = (ts) => Math.floor(ts / ROUND_MS);
const roundStartAt = (rid) => rid * ROUND_MS;
const roundEndAt = (rid) => roundStartAt(rid) + ROUND_MS;

async function ensureRoundStart(rid) {
  const key = `round:startPct:${rid}`;
  const exists = await redis.get(key);
  if (exists) return Number(exists);

  const last = Number(await redis.get(LAST_PCT_KEY));
  const v = Number.isFinite(last) ? last : 0;
  await redis.set(key, String(v), { ex: 86400 });
  return v;
}

async function finalizeRound(rid) {
  const endKey = `round:endPct:${rid}`;
  if (await redis.get(endKey)) return;

  const now = Date.now();
  if (now < roundEndAt(rid)) return;

  const start = Number(await redis.get(`round:startPct:${rid}`));
  const end = Number(await redis.get(LAST_PCT_KEY));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;

  const pct = clamp(end - start, -100, 200);
  await redis.set(endKey, String(pct), { ex: 86400 });

  await redis.lpush(
    "round:history",
    JSON.stringify({ roundId: rid, pct: Math.round(pct), ts: now })
  );
  await redis.ltrim("round:history", 0, 17);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") return res.status(405).end();

    const now = Date.now();
    const sec = Math.floor(now / 1000);
    const lock = await redis.set(`${LOCK_PREFIX}${sec}`, "1", { nx: true, ex: 5 });

    let series = [];
    const raw = await redis.get(SERIES_KEY);
    if (raw) try { series = JSON.parse(raw); } catch {}

    let lastPct = Number(await redis.get(LAST_PCT_KEY));
    if (!Number.isFinite(lastPct)) lastPct = 0;

    // init
    if (!series.length) {
      let p = lastPct;
      for (let i = 90; i >= 1; i--) {
        p = clamp(p + rand(-1.5, 1.5), -100, 200);
        series.push([now - i * 1000, Number(p.toFixed(2))]);
      }
      lastPct = series.at(-1)[1];
      await redis.set(SERIES_KEY, JSON.stringify(series), { ex: 3600 });
      await redis.set(LAST_PCT_KEY, String(lastPct), { ex: 3600 });
      await ensureRoundStart(roundIdByTs(now));
      return res.json({ serverNow: now, series });
    }

    if (lock) {
      const lastTs = series.at(-1)[0];
      if (now - lastTs >= 900) {
        lastPct = clamp(series.at(-1)[1] + rand(-2, 2), -100, 200);
        series.push([now, Number(lastPct.toFixed(2))]);
        if (series.length > 240) series = series.slice(-240);

        await redis.set(SERIES_KEY, JSON.stringify(series), { ex: 3600 });
        await redis.set(LAST_PCT_KEY, String(lastPct), { ex: 3600 });

        const rid = roundIdByTs(now);
        await ensureRoundStart(rid);
        await finalizeRound(rid - 1);
      }
    }

    const fresh = await redis.get(SERIES_KEY);
    if (fresh) try { series = JSON.parse(fresh); } catch {}

    res.json({ serverNow: now, series });
  } catch (e) {
    res.status(500).json({ error: "series_error", message: String(e) });
  }
}
