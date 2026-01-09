import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";
import { BET_MS, roundIdByNow, roundStartAt } from "../lib/game";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const toNano = (v) => Math.round(Number(v) * 1e9);

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).end();

    const { address, roundId, side, amountTon } = req.body;
    if (!address) return res.status(400).json({ error: "no_address" });
    if (!["long", "short"].includes(side)) return res.status(400).json({ error: "bad_side" });

    const amountNano = toNano(amountTon);
    if (!amountNano || amountNano <= 0) return res.status(400).json({ error: "bad_amount" });

    const friendly = Address.parse(address).toString({ urlSafe: true, bounceable: false });

    const now = Date.now();
    const rid = roundIdByNow(now);
    if (Number(roundId) !== rid) return res.status(400).json({ error: "bad_round" });

    if (now >= roundStartAt(rid) + BET_MS)
      return res.status(400).json({ error: "bets_closed" });

    const betKey = `bet:${rid}:${friendly}`;
    const balKey = `bal:${friendly}`;

    let bal = Number(await redis.get(balKey) || 0);

    const oldRaw = await redis.get(betKey);
    if (oldRaw) {
      const old = JSON.parse(oldRaw);
      bal += Number(old.amountNano);
    }

    if (bal < amountNano) return res.status(400).json({ error: "insufficient" });

    bal -= amountNano;
    await redis.set(balKey, String(bal));

    await redis.set(
      betKey,
      JSON.stringify({ roundId: rid, side, amountNano, placedAt: now }),
      { ex: 86400 }
    );

    res.json({ ok: true, replaced: !!oldRaw });
  } catch (e) {
    res.status(500).json({ error: "bet_place_error", message: String(e) });
  }
}
