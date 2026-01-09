import { Redis } from "@upstash/redis";

export function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    const e = new Error(
      "Missing UPSTASH env: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN"
    );
    e.code = "NO_UPSTASH_ENV";
    throw e;
  }
  return new Redis({ url, token });
}
