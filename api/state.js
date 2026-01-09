const { BET_MS, ROUND_MS, getRoundMeta, pushHistoryIfFinished, redis } = require("../lib/game");

module.exports = async (req, res) => {
  try {
    const now = Date.now();
    const round = await getRoundMeta(now);
    await pushHistoryIfFinished(round, now);

    const hist = await redis.lrange("game:history", 0, 11);
    const history = (hist || []).map(s => {
      const [rid, pct] = String(s).split(":");
      return { roundId: Number(rid), pct: Number(pct) };
    });

    res.json({
      serverNow: now,
      betMs: BET_MS,
      roundMs: ROUND_MS,
      round: {
        roundId: round.roundId,
        startAt: round.startAt,
        endAt: round.endAt,
        nextAt: round.nextAt
      },
      history
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "state failed" });
  }
};
