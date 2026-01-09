// api/series.js
import { redis, BET_MS, PLAY_MS, ROUND_MS, roundIdByNow, roundStartAt, roundEndAt, pickOutcomePctForRound, generateVisibleSeries } from "../lib/game";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "GET") return res.status(405).json({ error: "method" });

    const now = Date.now();
    const rid = roundIdByNow(now);

    // outcome заранее, фиксируем в Redis 1 раз (одинаково у всех)
    const metaKey = `round:meta:${rid}`;
    let meta = await redis.get(metaKey);
    let finalPctAbs;

    if (meta) {
      finalPctAbs = Number(JSON.parse(meta).finalPctAbs);
    } else {
      finalPctAbs = Number(pickOutcomePctForRound(rid).toFixed(6));
      await redis.set(metaKey, JSON.stringify({
        roundId: rid,
        startAt: roundStartAt(rid),
        endAt: roundStartAt(rid) + BET_MS,
        finishAt: roundEndAt(rid),
        finalPctAbs
      }), { ex: 60 * 60 * 6 });
    }

    // серия до текущего момента
    const series = generateVisibleSeries(rid, now, finalPctAbs);

    // если раунд завершился — положим результат в round:endPct:* (чтобы bet_settle работал)
    const finishAt = roundEndAt(rid);
    if (now >= finishAt) {
      const endKey = `round:endPct:${rid}`;
      const exists = await redis.get(endKey);
      if (!exists) {
        await redis.set(endKey, String(Number(finalPctAbs.toFixed(0))), { ex: 24 * 60 * 60 });
        // история
        await redis.lpush("round:history", JSON.stringify({ roundId: rid, pct: Number(finalPctAbs.toFixed(0)), ts: now }));
        await redis.ltrim("round:history", 0, 17);
        await redis.expire("round:history", 24 * 60 * 60);
      }
    }

    return res.status(200).json({
      serverNow: now,
      betMs: BET_MS,
      playMs: PLAY_MS,
      roundMs: ROUND_MS,
      roundId: rid,
      series
    });
  } catch (e) {
    return res.status(500).json({ error: "series_error", message: String(e) });
  }
}
