export const config = { runtime: "nodejs" };

import { getRedis } from "../lib/redis.js";
import { BET_MS, ROUND_MS, getRoundMeta } from "../lib/game.js";

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
    const round = getRoundMeta(now);

    // берём историю, которую пишет series.js в round:history
    const rows = await redis.lrange("round:history", 0, 11);
    const history = (rows || []).map((s) => {
      try {
        const j = JSON.parse(String(s));
        return { roundId: Number(j.roundId), pct: Number(j.pct) };
      } catch {
        return null;
      }
    }).filter(Boolean);

    res.json({
      serverNow: now,
      betMs: BET_MS,
      roundMs: ROUND_MS,
      round: {
        roundId: round.roundId,
        startAt: round.startAt,
        endAt: round.endAt,   // конец ставки (BET)
        nextAt: round.nextAt  // конец раунда (finish)
      },
      history
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "state_failed", message: String(e) });
  }
}
