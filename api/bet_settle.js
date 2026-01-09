import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";
import { roundEndAt, MIN_Y, MAX_Y } from "../lib/game";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).end();

    const { address, roundId } = req.body;
    const friendly = Address.parse(address).toString({ urlSafe: true, bounceable: false });

    const now = Date.now();
    if (now < roundEndAt(roundId))
      return res.json({ ok: true, status: "pending" });

    const settledKey = `settled:${roundId}:${friendly}`;
    if (await redis.get(settledKey))
      return res.json({ ok: true, status: "already_settled" });

    const betRaw = await redis.get(`bet:${roundId}:${friendly}`);
    if (!betRaw) return res.status(404).json({ error: "no_bet" });

    let pct = Number(await redis.get(`round:endPct:${roundId}`));
    if (!Number.isFinite(pct)) return res.json({ ok: true, status: "pending" });

    pct = clamp(pct, MIN_Y, MAX_Y);

    const bet = JSON.parse(betRaw);
    const stake = Number(bet.amountNano);
    const m = (bet.side === "long" ? pct : -pct) / 100;

    let ret = Math.floor(stake * (1 + m));
    if (ret < 0) ret = 0;

    const balKey = `bal:${friendly}`;
    const bal = Number(await redis.get(balKey) || 0);
    await redis.set(balKey, String(bal + ret));
    await redis.set(settledKey, "1", { ex: 86400 });

    res.json({
      ok: true,
      status: "settled",
      pct,
      returnedTon: ret / 1e9,
      profitTon: (ret - stake) / 1e9
    });
  } catch (e) {
    res.status(500).json({ error: "bet_settle_error", message: String(e) });
  }
}
