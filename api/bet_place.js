export const config = { runtime: "nodejs" };

import { Address } from "@ton/core";
import { getRedis } from "../lib/redis.js";
import { BET_MS, roundIdByNow, roundStartAt } from "../lib/game.js";

function normalizeUser(address) {
  const a = String(address || "").trim();
  if (!a) return null;
  if (a === "guest") return "guest";
  const parsed = Address.parse(a);
  return parsed.toString({ urlSafe: true, bounceable: false, testOnly: false });
}

function toNano(amountTon) {
  const n = Number(amountTon);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1e9);
}

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
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    const { address, roundId, side, amountTon } = req.body || {};

    const user = normalizeUser(address);
    if (!user) return res.status(400).json({ error: "bad_address" });

    const s = String(side || "").toLowerCase();
    if (s !== "long" && s !== "short") return res.status(400).json({ error: "bad_side" });

    const amountNano = toNano(amountTon);
    if (!amountNano) return res.status(400).json({ error: "bad_amount" });

    const now = Date.now();
    const curRound = roundIdByNow(now);
    const rid = Number(roundId);

    if (!Number.isFinite(rid) || rid !== curRound) return res.status(400).json({ error: "bad_round" });

    const betEnd = roundStartAt(curRound) + BET_MS;
    if (now >= betEnd) return res.status(400).json({ error: "bets_closed" });

    const betKey = `bet:${rid}:${user}`;
    const balKey = `bal:${user}`;

    // баланс
    let bal = Number(await redis.get(balKey) || "0");
    if (!Number.isFinite(bal)) bal = 0;

    // разрешаем замену ставки: возвращаем старую сумму
    let old = null;
    const oldRaw = await redis.get(betKey);
    if (oldRaw) {
      try { old = JSON.parse(oldRaw); } catch {}
    }
    if (old?.amountNano) bal += Number(old.amountNano);

    if (bal < amountNano) return res.status(400).json({ error: "insufficient" });

    bal -= amountNano;
    await redis.set(balKey, String(bal));

    const bet = { roundId: rid, address: user, side: s, amountNano, placedAt: now };
    await redis.set(betKey, JSON.stringify(bet), { ex: 24 * 60 * 60 });

    return res.json({ ok: true, replaced: !!oldRaw });
  } catch (e) {
    return res.status(500).json({ error: "bet_place_error", message: String(e) });
  }
}
