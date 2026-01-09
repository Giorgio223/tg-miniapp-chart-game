import { Redis } from "@upstash/redis";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// РАУНД: 19 сек
// СТАВКИ: 7 сек
// ИГРА: 12 сек (не показываем)
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
    const endAt = startAt + BET_MS;       // конец ставок
    const nextAt = startAt + ROUND_MS;    // конец раунда

    return res.status(200).json({
      serverNow: now,
      betMs: BET_MS,
      roundMs: ROUND_MS,
      round: { roundId, startAt, endAt, nextAt },
      history: []
    });
  } catch (e) {
    return res.status(500).json({ error: "state_error", message: String(e) });
  }
}
