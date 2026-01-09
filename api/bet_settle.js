// api/bet_settle.js
import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";
import { ROUND_MS, roundStartAt, roundEndAt, MIN_Y, MAX_Y } from "../lib/game";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function canonicalFriendly(addr) {
  const a = Address.parse(String(addr));
  return a.toString({ urlSafe: true, bounceable: false, testOnly: false });
}
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
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
    const finishAt = roundEndAt(rid);
    if (now < finishAt) return res.status(200).json({ ok: true, status: "pending" });

    const betKey = `bet:${rid}:${friendly}`;
    const betRaw = await redis.get(betKey);
    if (!betRaw) return res.status(404).json({ error: "no_bet" });

    const settledKey = `settled:${rid}:${friendly}`;
    const already = await redis.get(settledKey);
    if (already) return res.status(200).json({ ok: true, status: "already_settled" });

    const bet = JSON.parse(betRaw);

    // результат лежит тут (выставляет series.js)
    let resultPct = Number(await redis.get(`round:endPct:${rid}`));
    if (!Number.isFinite(resultPct)) return res.status(200).json({ ok: true, status: "pending" });

    // ✅ диапазон -100..200
    resultPct = clamp(resultPct, MIN_Y, MAX_Y);

    const side = String(bet.side);
    const stakeNano = Number(bet.amountNano);

    // payout модель как у тебя: return = stake * (1 + m), где m = pct/100
    const m = (side === "long" ? resultPct : -resultPct) / 100;

    let returnNano = Math.floor(stakeNano * (1 + m));
    if (!Number.isFinite(returnNano) || returnNano < 0) returnNano = 0;

    const balKey = `bal:${friendly}`;
    const curBal = Number(await redis.get(balKey) || "0");
    await redis.set(balKey, String((Number.isFinite(curBal) ? curBal : 0) + returnNano));

    await redis.set(settledKey, "1", { ex: 24 * 60 * 60 });

    const deltaNano = returnNano - stakeNano;

    return res.status(200).json({
      ok: true,
      status: "settled",
      pct: resultPct,
      side,
      returnedTon: returnNano / 1e9,
      profitTon: deltaNano / 1e9
    });
  } catch (e) {
    return res.status(500).json({ error: "bet_settle_error", message: String(e) });
  }
}
