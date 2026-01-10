const { Redis } = require("@upstash/redis");

module.exports.config = { runtime: "nodejs" };

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash env missing: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");
  return new Redis({ url, token });
}

function safeJson(s){ try{ return JSON.parse(s); }catch{ return null; } }

module.exports = async function handler(req, res) {
  try{
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");

    const redis = getRedis();
    const roundId = Number(req.query && req.query.roundId);

    if (!Number.isFinite(roundId)) {
      return res.status(400).json({ ok:false, message:"roundId required" });
    }

    const totalsKey = `round:betTotals:${roundId}`;
    const h = await redis.hgetall(totalsKey);

    const longAmount  = Number(h?.longAmount  || 0);
    const shortAmount = Number(h?.shortAmount || 0);
    const longCount   = Number(h?.longCount   || 0);
    const shortCount  = Number(h?.shortCount  || 0);

    // ставки (последние 200)
    const betsKey = `round:bets:${roundId}`;
    const raw = await redis.lrange(betsKey, 0, 199);
    const bets = (raw || []).map(safeJson).filter(Boolean);

    return res.status(200).json({
      ok:true,
      roundId,
      totals: {
        longAmount:  isFinite(longAmount) ? longAmount : 0,
        shortAmount: isFinite(shortAmount) ? shortAmount : 0,
        longCount:   isFinite(longCount) ? longCount : 0,
        shortCount:  isFinite(shortCount) ? shortCount : 0
      },
      bets
    });
  }catch(e){
    return res.status(500).json({
      ok:false,
      error:"bets_error",
      message:String(e && (e.stack || e.message || e))
    });
  }
};
