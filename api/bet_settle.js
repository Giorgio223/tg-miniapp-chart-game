import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BET_MS = 9000;
const POST_DELAY_MS = 6000;
const ROUND_MS = BET_MS + POST_DELAY_MS;

// выплата (1.9x) — можно поменять позже
const PAYOUT_MULT = 1.9;

function canonicalFriendly(addr) {
  const a = Address.parse(String(addr));
  return a.toString({ urlSafe: true, bounceable: false, testOnly: false });
}

async function getLastPrice() {
  const p = Number(await redis.get("chart:lastPrice"));
  return Number.isFinite(p) ? p : 100;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    const { address, roundId } = req.body || {};
    if (!address) return res.status(400).json({ error: "no_address" });

    let friendly = "";
    try { friendly = canonicalFriendly(address); }
    catch { return res.status(400).json({ error: "bad_address" }); }

    const rid = Number(roundId);
    if (!Number.isFinite(rid)) return res.status(400).json({ error: "bad_round" });

    const now = Date.now();
    const startAt = rid * ROUND_MS;
    const endAt = startAt + BET_MS;
    if (now < endAt) return res.status(400).json({ error: "too_early" });

    const betKey = `bet:${rid}:${friendly}`;
    const betRaw = await redis.get(betKey);
    if (!betRaw) return res.status(404).json({ error: "no_bet" });

    const settledKey = `settled:${rid}:${friendly}`;
    const already = await redis.get(settledKey);
    if (already) return res.status(200).json({ ok: true, status: "already_settled" });

    const bet = typeof betRaw === "string" ? JSON.parse(betRaw) : betRaw;

    // фиксируем старт/энд цену
    const startPrice = Number(await redis.get(`chart:roundStart:${rid}`));
    const endKey = `chart:roundEnd:${rid}`;
    let endPrice = Number(await redis.get(endKey));

    if (!Number.isFinite(endPrice)) {
      endPrice = await getLastPrice();
      await redis.set(endKey, String(endPrice), { ex: 24 * 60 * 60 });
    }

    const winnerSide = endPrice > startPrice ? "long" : "short";
    const win = (String(bet.side) === winnerSide);

    let creditedNano = 0;
    if (win) {
      creditedNano = Math.floor(Number(bet.amountNano) * PAYOUT_MULT);
      const balKey = `bal:${friendly}`;
      const curBal = Number(await redis.get(balKey) || "0");
      await redis.set(balKey, String(curBal + creditedNano));
    }

    await redis.set(settledKey, "1", { ex: 24 * 60 * 60 });

    return res.status(200).json({
      ok: true,
      roundId: rid,
      startPrice,
      endPrice,
      winnerSide,
      win,
      creditedTon: creditedNano / 1e9
    });
  } catch (e) {
    return res.status(500).json({ error: "bet_settle_error", message: String(e) });
  }
}
