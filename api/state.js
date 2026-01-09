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

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "GET") return res.status(405).json({ error: "method" });

    const now = Date.now();
    const roundId = Math.floor(now / ROUND_MS);
    const startAt = roundId * ROUND_MS;
    const endAt = startAt + BET_MS;     // конец ставок
    const nextAt = startAt + ROUND_MS;  // конец раунда

    // История раундов (последние ~18)
    const history = (await redis.lrange("round:history", 0, 17)) || [];
    const parsed = history
      .map((x) => {
        try { return JSON.parse(x); } catch { return null; }
      })
      .filter(Boolean);

    return res.status(200).json({
      serverNow: now,
      betMs: BET_MS,
      roundMs: ROUND_MS,
      round: { roundId, startAt, endAt, nextAt },
      history: parsed
    });
  } catch (e) {
    return res.status(500).json({ error: "state_error", message: String(e) });
  }
}
