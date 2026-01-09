// api/bet_place.js
import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";
import { BET_MS, ROUND_MS, roundIdByNow, roundStartAt } from "../lib/game";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function canonicalFriendly(addr) {
  const a = Address.parse(String(addr));
  return a.toString({ urlSafe: true, bounceable: false, testOnly: false });
}
function toNano(amountTon) {
  const n = Number(amountTon);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1e9);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    const { address, roundId, side, amountTon } = req.body || {};
    if (!address) return res.status(400).json({ error: "no_address" });

    const s = String(side || "").toLowerCase();
    if (s !== "long" && s !== "short") return res.status(400).json({ error: "bad_side" });

    const amountNano = toNano(amountTon);
    if (!amountNano) return res.status(400).json({ error: "bad_amount" });

    let friendly = "";
    try { friendly = canonicalFriendly(address); }
    catch { return res.status(400).json({ error: "bad_address" }); }

    const now = Date.now();
    const curRound = roundIdByNow(now);
    const startAt = roundStartAt(curRound);
    const endAt = startAt + BET_MS;

    const rid = Number(roundId);
    if (!Number.isFinite(rid) || rid !== curRound) return res.status(400).json({ error: "bad_round" });
    if (now >= endAt) return res.status(400).json({ error: "bets_closed" });

    const betKey = `bet:${rid}:${friendly}`;

    // ✅ разрешаем замену ставки в окне ставок: если была старая — вернем старую сумму, потом спишем новую
    const balKey = `bal:${friendly}`;
    const curBal = Number(await redis.get(balKey) || "0");

    let old = null;
    const oldRaw = await redis.get(betKey);
    if (oldRaw) {
      try { old = JSON.parse(oldRaw); } catch {}
    }

    let bal = Number.isFinite(curBal) ? curBal : 0;
    if (old?.amountNano) bal += Number(old.amountNano); // вернули старую ставку

    if (bal < amountNano) return res.status(400).json({ error: "insufficient" });

    // списываем новую
    bal -= amountNano;
    await redis.set(balKey, String(bal));

    const bet = {
      roundId: rid,
      address: friendly,
      side: s,
      amountNano,
      placedAt: now
    };

    await redis.set(betKey, JSON.stringify(bet), { ex: 24 * 60 * 60 });

    return res.status(200).json({ ok: true, replaced: !!oldRaw });
  } catch (e) {
    return res.status(500).json({ error: "bet_place_error", message: String(e) });
  }
}
