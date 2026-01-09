import { Redis } from "@upstash/redis";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Настройки раунда
const BET_MS = 9000;         // окно ставок
const POST_DELAY_MS = 6000;  // пауза после
const ROUND_MS = BET_MS + POST_DELAY_MS;

async function getLastPrice() {
  const p = Number(await redis.get("chart:lastPrice"));
  return Number.isFinite(p) ? p : 100;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "GET") return res.status(405).json({ error: "method" });

    const now = Date.now();
    const roundId = Math.floor(now / ROUND_MS);
    const startAt = roundId * ROUND_MS;
    const endAt = startAt + BET_MS;
    const nextAt = startAt + ROUND_MS;

    // фиксируем стартовую цену для раунда (один раз)
    const startKey = `chart:roundStart:${roundId}`;
    const exists = await redis.get(startKey);
    if (!exists) {
      const p = await getLastPrice();
      await redis.set(startKey, String(p), { ex: 24 * 60 * 60 });
    }

    return res.status(200).json({
      serverNow: now,
      spinMs: BET_MS,
      postDelayMs: POST_DELAY_MS,
      roundMs: ROUND_MS,
      round: {
        roundId,
        startAt,
        endAt,
        nextAt
      },
      history: []
    });
  } catch (e) {
    return res.status(500).json({ error: "state_error", message: String(e) });
  }
}
