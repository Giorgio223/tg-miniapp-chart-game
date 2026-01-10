import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";

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

    const { address, amountTon, comment } = req.body || {};
    if (!address) return res.status(400).json({ error: "no_address" });

    const amt = Number(amountTon);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "bad_amount" });

    const friendly = canonicalFriendly(address);

    // анти-дабл-кредит по комменту
    if (comment) {
      const depKey = `dep:${comment}`;
      const already = await redis.get(depKey);
      if (already) return res.status(200).json({ ok: true, status: "already_credited" });
      await redis.set(depKey, "1");
      await redis.expire(depKey, 3600);
    }

    const nano = Math.floor(amt * 1e9);
    const balKey = `bal:${friendly}`;
    const cur = Number(await redis.get(balKey) || "0");
    const next = (Number.isFinite(cur) ? cur : 0) + nano;
    await redis.set(balKey, String(next));

    return res.status(200).json({ ok: true, creditedTon: nano / 1e9 });
  } catch (e) {
    return res.status(500).json({ error: "deposit_credit_error", message: String(e) });
  }
}
