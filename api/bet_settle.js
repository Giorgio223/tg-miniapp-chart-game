export const config = { runtime: "nodejs" };

import { Address } from "@ton/core";
import { getRedis } from "../lib/redis.js";
import { roundEndAt, MIN_Y, MAX_Y, clamp } from "../lib/game.js";

function normalizeUser(address) {
  const a = String(address || "").trim();
  if (!a) return null;
  if (a === "guest") return "guest";
  const parsed = Address.parse(a);
  return parsed.toString({ urlSafe: true, bounceable: false, testOnly: false });
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

    const { address, roundId } = req.body || {};

    const user = normalizeUser(address);
    if (!user) return res.status(400).json({ error: "bad_address" });

    const rid = Number(roundId);
    if (!Number.isFinite(rid)) return res.status(400).json({ error: "bad_round" });

    const now = Date.now();
    if (now < roundEndAt(rid)) return res.json({ ok: true, status: "pending" });

    const betKey = `bet:${rid}:${user}`;
    const betRaw = await redis.get(betKey);
    if (!betRaw) return res.status(404).json({ error: "no_bet" });

    const settledKey = `settled:${rid}:${user}`;
    if (await redis.get(settledKey)) return res.json({ ok: true, status: "already_settled" });

    // результат раунда выставляет series.js
    let pct = Number(await redis.get(`round:endPct:${rid}`));
    if (!Number.isFinite(pct)) return res.json({ ok: true, status: "pending" });
    pct = clamp(pct, MIN_Y, MAX_Y);

    const bet = JSON.parse(betRaw);
    const side = String(bet.side);
    const stakeNano = Number(bet.amountNano);

    const m = (side === "long" ? pct : -pct) / 100;
    let returnNano = Math.floor(stakeNano * (1 + m));
    if (!Number.isFinite(returnNano) || returnNano < 0) returnNano = 0;

    const balKey = `bal:${user}`;
    let bal = Number(await redis.get(balKey) || "0");
    if (!Number.isFinite(bal)) bal = 0;
    await redis.set(balKey, String(bal + returnNano));

    await redis.set(settledKey, "1", { ex: 24 * 60 * 60 });

    return res.json({
      ok: true,
      status: "settled",
      pct,
      side,
      returnedTon: returnNano / 1e9,
      profitTon: (returnNano - stakeNano) / 1e9
    });
  } catch (e) {
    return res.status(500).json({ error: "bet_settle_error", message: String(e) });
  }
}
