// api/state.js
import { redis, BET_MS, ROUND_MS, roundIdByNow, roundStartAt, roundEndAt } from "../lib/game";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "GET") return res.status(405).json({ error: "method" });

    const now = Date.now();
    const rid = roundIdByNow(now);
    const startAt = roundStartAt(rid);
    const endAt = startAt + BET_MS;
    const nextAt = roundEndAt(rid);

    // история
    const hist = await redis.lrange("round:history", 0, 11);
    const history = (hist || []).map(s => {
      try { return JSON.parse(s); } catch { return null; }
    }).filter(Boolean).map(x => ({ roundId: Number(x.roundId), pct: Number(x.pct) }));

    return res.status(200).json({
      serverNow: now,
      betMs: BET_MS,
      roundMs: ROUND_MS,
      round: { roundId: rid, startAt, endAt, nextAt },
      history
    });
  } catch (e) {
    return res.status(500).json({ error: "state_error", message: String(e) });
  }
}
