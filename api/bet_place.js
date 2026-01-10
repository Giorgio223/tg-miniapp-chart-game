const { Redis } = require("@upstash/redis");

module.exports.config = { runtime: "nodejs" };

const BET_MS = 7000;
const PLAY_MS = 12000;
const ROUND_MS = BET_MS + PLAY_MS;

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash env missing: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");
  return new Redis({ url, token });
}

function roundIdByNow(nowMs) {
  return Math.floor(nowMs / ROUND_MS);
}
function roundStartAt(roundId) {
  return roundId * ROUND_MS;
}

module.exports = async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");

    if (req.method !== "POST") {
      return res.status(405).json({ ok:false, message:"POST only" });
    }

    const redis = getRedis();
    const now = Date.now();

    const body = req.body || {};
    const roundId = Number(body.roundId);
    const side = String(body.side || "").toUpperCase();
    const amount = Number(body.amount);
    const wallet = String(body.wallet || "");

    if (!Number.isFinite(roundId)) return res.status(400).json({ ok:false, message:"roundId invalid" });
    if (side !== "LONG" && side !== "SHORT") return res.status(400).json({ ok:false, message:"side invalid" });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok:false, message:"amount invalid" });

    // принимаем ставки только в BET фазе текущего раунда
    const current = roundIdByNow(now);
    if (roundId !== current) return res.status(400).json({ ok:false, message:"bet only for current round" });

    const startAt = roundStartAt(roundId);
    const phaseMs = now - startAt;
    if (phaseMs < 0 || phaseMs >= BET_MS) {
      return res.status(400).json({ ok:false, message:"bet window closed" });
    }

    const bet = {
      roundId,
      side,
      amount,
      wallet,
      ts: now
    };

    // 1) список ставок раунда
    const betsKey = `round:bets:${roundId}`;
    await redis.lpush(betsKey, JSON.stringify(bet));
    // лимит на всякий случай (например 5000 ставок на раунд)
    await redis.ltrim(betsKey, 0, 4999);

    // 2) totals
    const totalsKey = `round:betTotals:${roundId}`;
    if (side === "LONG") {
      await redis.hincrbyfloat(totalsKey, "longAmount", amount);
      await redis.hincrby(totalsKey, "longCount", 1);
    } else {
      await redis.hincrbyfloat(totalsKey, "shortAmount", amount);
      await redis.hincrby(totalsKey, "shortCount", 1);
    }

    return res.status(200).json({ ok:true, bet });
  } catch (e) {
    return res.status(500).json({
      ok:false,
      error:"bet_place_error",
      message:String(e && (e.stack || e.message || e))
    });
  }
};
