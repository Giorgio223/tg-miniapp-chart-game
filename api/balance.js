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
    if (req.method !== "GET") return res.status(405).json({ error: "method" });

    const address = String(req.query.address || "").trim();
    if (!address) return res.status(400).json({ error: "no_address" });

    let friendly = "";
    try { friendly = canonicalFriendly(address); }
    catch { return res.status(400).json({ error: "bad_address" }); }

    const nano = Number(await redis.get(`bal:${friendly}`) || "0");
    const safeNano = Number.isFinite(nano) ? nano : 0;

    return res.status(200).json({
      ok: true,
      address: friendly,
      nano: safeNano,
      ton: safeNano / 1e9,
      balanceTon: safeNano / 1e9
    });
  } catch (e) {
    return res.status(500).json({ error: "balance_error", message: String(e) });
  }
}
