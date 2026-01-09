export const BET_MS = 7000;
export const PLAY_MS = 12000;
export const ROUND_MS = BET_MS + PLAY_MS;

// Диапазон для результата (у тебя на фронте MIN_Y=-100 MAX_Y=200)
export const MIN_Y = -100;
export const MAX_Y = 200;

export function roundIdByNow(nowMs) {
  return Math.floor(nowMs / ROUND_MS);
}
export function roundStartAt(roundId) {
  return roundId * ROUND_MS;
}
export function roundBetEndAt(roundId) {
  return roundStartAt(roundId) + BET_MS;
}
export function roundEndAt(roundId) {
  return roundStartAt(roundId) + ROUND_MS;
}

export function getRoundMeta(nowMs) {
  const roundId = roundIdByNow(nowMs);
  const startAt = roundStartAt(roundId);
  const endAt = startAt + BET_MS;     // конец приёма ставок
  const nextAt = startAt + ROUND_MS;  // конец раунда (finish)
  return { roundId, startAt, endAt, nextAt };
}

export function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}
