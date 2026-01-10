import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";
import { BET_MS, roundIdByNow, roundStartAt } from "../lib/game";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function canonicalFriendly(addr) {
  const a = Address.parse(String(addr));
  return a.toString({ urlSafe: true, bounceable: false, testOnly: false });
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

    // отменять можно ТОЛЬКО в текущем раунде и только пока окно ставок открыто
    const now = Date.now();
    const curRound = roundIdByNow(now);
    if (rid !== curRound) return res.status(400).json({ error: "not_current_round" });

    const startAt = roundStartAt(curRound);
    const endAt = startAt + BET_MS;
    if (now >= endAt) return res.status(400).json({ error: "bets_closed" });

    const betKey = `bet:${rid}:${friendly}`;
    const betRaw = await redis.get(betKey);
    if (!betRaw) return res.status(404).json({ error: "no_bet" });

    let bet = null;
    try { bet = JSON.parse(betRaw); } catch {}
    const amountNano = Number(bet?.amountNano);
    if (!Number.isFinite(amountNano) || amountNano <= 0) return res.status(400).json({ error: "bad_bet" });

    // вернуть на баланс
    const balKey = `bal:${friendly}`;
    const curBal = Number(await redis.get(balKey) || "0");
    const nextBal = (Number.isFinite(curBal) ? curBal : 0) + amountNano;
    await redis.set(balKey, String(nextBal));

    // удалить ставку
    await redis.del(betKey);

    return res.status(200).json({ ok: true, refundedTon: amountNano / 1e9 });
  } catch (e) {
    return res.status(500).json({ error: "bet_cancel_error", message: String(e) });
  }
}
