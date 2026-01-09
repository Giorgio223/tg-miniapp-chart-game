// /lib/game.js
const { Redis } = require("@upstash/redis");

const redis = Redis.fromEnv(); // берет UPSTASH_REDIS_REST_URL / TOKEN

// ===== CONFIG =====
const BET_MS = 7000;
const ROUND_MS = 19000;
const TICK_MS = 200;

const MIN_Y = -100;
const MAX_Y = 200;

// можно добавить SECRET_SEED в env (рекомендую)
const SECRET_SEED = process.env.SECRET_SEED || "default_seed_change_me";

// ===== deterministic PRNG =====
function xfnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rngForRound(startAt) {
  const seed = xfnv1a(`${SECRET_SEED}:${startAt}`);
  return mulberry32(seed);
}
function rand(rng, min, max) {
  return min + rng() * (max - min);
}

// ===== outcome распределение =====
// long: 0..50 30%, 50..100 10%, 100..150 5%, 150..200 3% => 48%
// short: -0..-100 49%
// остаток 3% -> 0%
function pickOutcomePctDeterministic(startAt) {
  const rng = rngForRound(startAt);
  const r = rng() * 100;

  if (r < 30) return rand(rng, 0, 50);
  if (r < 40) return rand(rng, 50, 100);
  if (r < 45) return rand(rng, 100, 150);
  if (r < 48) return rand(rng, 150, 200);
  if (r < 97) return -rand(rng, 0, 100);
  return 0;
}

// “нить” на лету, чтобы не хранить огромный JSON в Redis
function generateVisibleSeries(startAt, nextAt, finalPct, now) {
  const rng = rngForRound(startAt); // тот же rng для одинаковой траектории
  const totalSteps = Math.max(30, Math.floor((nextAt - startAt) / TICK_MS));
  const visibleSteps = Math.max(1, Math.min(totalSteps, Math.floor((now - startAt) / TICK_MS)));

  const startVal = rand(rng, -3, 3);
  let v = startVal;

  const points = [];
  for (let i = 0; i <= visibleSteps; i++) {
    const t = startAt + i * TICK_MS;
    const p = Math.min(1, i / totalSteps);

    const target = startVal + (finalPct - startVal) * p;
    const pull = (target - v) * 0.08;
    const noise = rand(rng, -1.1, 1.1) * (1 - p) * 0.6;

    v = v + pull + noise;
    v = Math.max(MIN_Y, Math.min(MAX_Y, v));

    if (t >= nextAt) v = finalPct;

    points.push([t, Number(v.toFixed(3))]);
  }

  // гарантируем финальную точку в конце раунда
  if (now >= nextAt) {
    points.push([nextAt, Number(finalPct.toFixed(3))]);
  }

  return points;
}

function getRoundTimes(now) {
  // round старт = ближайший вниз кратный ROUND_MS
  const startAt = Math.floor(now / ROUND_MS) * ROUND_MS;
  const endAt = startAt + BET_MS;
  const nextAt = startAt + ROUND_MS;
  return { roundId: startAt, startAt, endAt, nextAt };
}

async function getRoundMeta(now) {
  const { roundId, startAt, endAt, nextAt } = getRoundTimes(now);
  const key = `round:${roundId}:meta`;

  let meta = await redis.hgetall(key);
  if (!meta || !meta.startAt) {
    // создаём детерминированно (одинаково у всех даже при гонках)
    const finalPct = pickOutcomePctDeterministic(startAt);

    // hset безопасно: одинаковые значения будут в итоге одинаковые
    await redis.hset(key, {
      startAt: String(startAt),
      endAt: String(endAt),
      nextAt: String(nextAt),
      finalPct: String(Number(finalPct.toFixed(6))),
    });

    meta = await redis.hgetall(key);
  }

  return {
    roundId,
    startAt: Number(meta.startAt),
    endAt: Number(meta.endAt),
    nextAt: Number(meta.nextAt),
    finalPct: Number(meta.finalPct),
  };
}

async function pushHistoryIfFinished(meta, now) {
  if (now < meta.nextAt) return;
  const doneKey = `round:${meta.roundId}:historyPushed`;
  const already = await redis.get(doneKey);
  if (already) return;

  await redis.lpush("game:history", `${meta.roundId}:${meta.finalPct}`);
  await redis.ltrim("game:history", 0, 11);
  await redis.set(doneKey, "1", { ex: 60 * 60 }); // 1 час
}

module.exports = {
  redis,
  BET_MS,
  ROUND_MS,
  getRoundMeta,
  pushHistoryIfFinished,
  generateVisibleSeries,
};
