export const config = { runtime: "nodejs" };

import { Address } from "@ton/core";
import { getRedis } from "../lib/redis.js";

function normalizeUser(address) {
  const a = String(address || "").trim();
  if (!a) return null;
  if (a === "guest") return "guest";
  // address у тебя приходит RAW (toRawString), но Address.parse это съедает
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
    if (req.method !== "GET") return res.status(405).json({ error: "method" });

    const address = req.query?.address;
    const user = normalizeUser(address);
    if (!user) return res.status(400).json({ error: "bad_address" });

    const balKey = `bal:${user}`;
    const nano = Number(await redis.get(balKey) || "0");
    const balanceTon = (Number.isFinite(nano) ? nano : 0) / 1e9;

    return res.json({ ok: true, balanceTon });
  } catch (e) {
    return res.status(500).json({ error: "balance_error", message: String(e) });
  }
}
