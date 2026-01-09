// lib/game.js
import { Redis } from "@upstash/redis";

export const config = { runtime: "nodejs" };

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// 19 сек: 7 сек ставки + 12 сек игра
export const BET_MS = 7000;
export const PLAY_MS = 12000;
export const ROUND_MS = BET_MS + PLAY_MS;

// серия плавная
export const TICK_MS = 200;

export const MIN_Y = -100;
export const MAX_Y = 200;

// добавь в Vercel ENV: SECRET_SEED (любая строка)
const SECRET_SEED = process.env.SECRET_SEED || "CHANGE_ME_SECRET_SEED";

// -------- deterministic rng --------
function xfnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
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
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

// round helpers
export function roundIdByNow(now) {
  return Math.floor(now / ROUND_MS); // как у тебя в bet_place/bet_settle
}
export function roundStartAt(roundId) {
  return roundId * ROUND_MS;
}
export function roundEndAt(roundId) {
  return roundStartAt(roundId) + ROUND_MS;
}

// ===== outcome распределение (как ты сказал) =====
// LONG: 0..50 30% | 50..100 10% | 100..150 5% | 150..200 3%  => 48%
// SHORT: остальные -> 49% (мы сделаем -0..-100)
// остаток 3% -> ровно 0%
export function pickOutcomePctForRound(roundId) {
  const startAt = roundStartAt(roundId);
  const rng = rngForRound(startAt);
  const r = rng() * 100;

  if (r < 30) return rand(rng, 0, 50);
  if (r < 40) return rand(rng, 50, 100);
  if (r < 45) return rand(rng, 100, 150);
  if (r < 48) return rand(rng, 150, 200);

  if (r < 97) return -rand(rng, 0, 100);

  return 0;
}

// генерим серию (проценты) так, чтобы в конце прийти к finalPct
export function generateVisibleSeries(roundId, now, finalPctAbs) {
  const startAt = roundStartAt(roundId);
  const finishAt = roundEndAt(roundId);
  const rng = rngForRound(startAt);

  const totalSteps = Math.max(30, Math.floor((finishAt - startAt) / TICK_MS));
  const visibleSteps = clamp(Math.floor((now - startAt) / TICK_MS), 0, totalSteps);

  // стартовое значение (чуть шум)
  const startVal = rand(rng, -3, 3);
  let v = startVal;

  const pts = [];
  for (let i = 0; i <= visibleSteps; i++) {
    const ts = startAt + i * TICK_MS;
    const p = totalSteps === 0 ? 1 : i / totalSteps;

    // движемся к финалу
    const target = startVal + (finalPctAbs - startVal) * p;
    const pull = (target - v) * 0.08;
    const noise = rand(rng, -1.1, 1.1) * (1 - p) * 0.6;

    v = v + pull + noise;
    v = clamp(v, MIN_Y, MAX_Y);

    if (i === totalSteps) v = finalPctAbs;

    pts.push([ts, Number(v.toFixed(3))]);
  }

  // если раунд закончился, гарантируем последнюю точку финала
  if (now >= finishAt) {
    pts.push([finishAt, Number(finalPctAbs.toFixed(3))]);
  }

  return pts;
}
