import { Redis } from "@upstash/redis";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BET_MS = 7000;
const PLAY_MS = 12000;
const ROUND_MS = BET_MS + PLAY_MS;

const HISTORY_KEY = "round:history";

function roundIdByNow(nowMs) {
  return Math.floor(nowMs / ROUND_MS);
}
function roundStartAt(roundId) {
  return roundId * ROUND_MS;
}

// минимальная финализация (берём сохранённый endPct или ставим 0 если нет)
// ВАЖНО: точный endPct у нас пишет series.js, а state.js лишь гарантирует history не пустая.
async function finalizeFallback(roundId) {
  if (roundId < 0) return;

  const endAt = roundStartAt(roundId) + ROUND_MS;
  if (Date.now() < endAt) return;

  const endKey = `round:endPct:${roundId}`;
  let endPct = await redis.get(endKey);

  const hist = await redis.lrange(HISTORY_KEY, 0, 0);
  const last = hist?.[0] ? JSON.parse(hist[0]) : null;
  if (last?.roundId === roundId) return;

  if (endPct == null) {
    endPct = "0";
    await redis.set(endKey, endPct);
  }

  const item = JSON.stringify({ roundId, pct: Number(endPct), ts: endAt });
  await redis.lpush(HISTORY_KEY, item);
  await redis.ltrim(HISTORY_KEY, 0, 49);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");

    const now = Date.now();
    const roundId = roundIdByNow(now);

    // гарантируем что прошлые раунды попали в историю
    await finalizeFallback(roundId - 1);
    await finalizeFallback(roundId - 2);

    const startAt = roundStartAt(roundId);
    const endAt = startAt + BET_MS;
    const nextAt = startAt + ROUND_MS;

    const rawHist = await redis.lrange(HISTORY_KEY, 0, 9);
    const history = (rawHist || [])
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);

    const treasuryAddress = process.env.TREASURY_TON_ADDRESS || "";

    return res.status(200).json({
      ok: true,
      serverNow: now,
      betMs: BET_MS,
      roundMs: ROUND_MS,
      treasuryAddress,
      round: { roundId, startAt, endAt, nextAt },
      history,
    });
  } catch (e) {
    return res.status(500).json({ error: "state_error", message: String(e) });
  }
}
