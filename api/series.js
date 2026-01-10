const { getRedis } = require("../lib/redis");
const { ROUND_MS, MIN_Y, MAX_Y, clamp } = require("../lib/game");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  let redis;
  try {
    redis = getRedis();
  } catch (e) {
    return res.status(500).json({ error: "redis_init_failed", message: String(e.message || e) });
  }

  if (req.method !== "GET") return res.status(405).json({ error: "method" });

  const SERIES_KEY = "chart:series";          // JSON [[ts,value],...]
  const CUR_PCT_KEY = "chart:curPct";         // string number
  const CUR_VEL_KEY = "chart:curVel";         // string number (инерция)
  const CUR_RID_KEY = "chart:curRoundId";     // string number
  const LOCK_PREFIX = "chart:tick250:";       // lock на 250мс-тик

  function roundIdByNow(nowMs) {
    return Math.floor(nowMs / ROUND_MS);
  }

  // “мягкий шум”
  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  try {
    const now = Date.now();
    const ridNow = roundIdByNow(now);

    // ---- загрузим текущее состояние
    let curRid = Number(await redis.get(CUR_RID_KEY));
    if (!Number.isFinite(curRid)) curRid = ridNow;

    let curPct = Number(await redis.get(CUR_PCT_KEY));
    if (!Number.isFinite(curPct)) curPct = 0;

    let vel = Number(await redis.get(CUR_VEL_KEY));
    if (!Number.isFinite(vel)) vel = 0;

    let series = [];
    const raw = await redis.get(SERIES_KEY);
    if (typeof raw === "string" && raw) {
      try { series = JSON.parse(raw); } catch { series = []; }
    }
    if (!Array.isArray(series)) series = [];

    // ---- если пусто: стартуем красивой историей около 0
    if (series.length === 0) {
      const base = 0;
      let p = base;
      let v = 0;

      // 30 секунд истории, 4 точки/сек = 120 точек
      for (let i = 120; i >= 1; i--) {
        // мягкая физика
        v = v * 0.88 + rand(-0.35, 0.35);
        p = clamp(p + v, MIN_Y, MAX_Y);
        series.push([now - i * 250, Number(p.toFixed(2))]);
      }

      curPct = series[series.length - 1][1];
      vel = v;
      curRid = ridNow;

      await redis.set(SERIES_KEY, JSON.stringify(series), { ex: 3600 });
      await redis.set(CUR_PCT_KEY, String(curPct), { ex: 3600 });
      await redis.set(CUR_VEL_KEY, String(vel), { ex: 3600 });
      await redis.set(CUR_RID_KEY, String(curRid), { ex: 3600 });

      return res.status(200).json({ serverNow: now, series });
    }

    // ---- если начался новый раунд: финализируем прошлый и СБРАСЫВАЕМ НА 0
    if (ridNow !== curRid) {
      // записываем результат прошлого раунда = curPct
      const endKey = `round:endPct:${curRid}`;
      const already = await redis.get(endKey);
      if (!already) {
        const pct = clamp(curPct, MIN_Y, MAX_Y);
        await redis.set(endKey, String(pct), { ex: 86400 });

        const item = { roundId: curRid, pct: Math.round(pct), ts: now };
        await redis.lpush("round:history", JSON.stringify(item));
        await redis.ltrim("round:history", 0, 17);
        await redis.expire("round:history", 86400);
      }

      // новый раунд начинается с 0
      curRid = ridNow;
      curPct = 0;
      vel = 0;

      // добавим “резет-точку” прямо сейчас, чтобы было видно что старт с 0
      series.push([now, 0]);

      await redis.set(CUR_RID_KEY, String(curRid), { ex: 3600 });
      await redis.set(CUR_PCT_KEY, String(curPct), { ex: 3600 });
      await redis.set(CUR_VEL_KEY, String(vel), { ex: 3600 });
      // ограничим серию
      if (series.length > 480) series = series.slice(-480);
      await redis.set(SERIES_KEY, JSON.stringify(series), { ex: 3600 });

      return res.status(200).json({ serverNow: now, series });
    }

    // ---- тик каждые 250ms, но с lock (чтобы много запросов не портили данные)
    const bucket = Math.floor(now / 250);
    const lockKey = `${LOCK_PREFIX}${bucket}`;
    const gotLock = await redis.set(lockKey, "1", { nx: true, ex: 3 });

    if (gotLock) {
      const lastTs = Number(series[series.length - 1]?.[0] || 0);
      if (now - lastTs >= 240) {
        // “волны”: инерция + ограничение скорости
        vel = vel * 0.90 + rand(-0.42, 0.42);   // шум
        vel = clamp(vel, -2.2, 2.2);            // ограничение скорости

        curPct = clamp(curPct + vel, MIN_Y, MAX_Y);

        series.push([now, Number(curPct.toFixed(2))]);
        if (series.length > 480) series = series.slice(-480);

        await redis.set(SERIES_KEY, JSON.stringify(series), { ex: 3600 });
        await redis.set(CUR_PCT_KEY, String(curPct), { ex: 3600 });
        await redis.set(CUR_VEL_KEY, String(vel), { ex: 3600 });
        await redis.set(CUR_RID_KEY, String(curRid), { ex: 3600 });
      }
    }

    // отдаем актуальную серию
    const raw2 = await redis.get(SERIES_KEY);
    if (typeof raw2 === "string" && raw2) {
      try { series = JSON.parse(raw2); } catch {}
    }

    return res.status(200).json({ serverNow: now, series });
  } catch (e) {
    return res.status(500).json({ error: "series_error", message: String(e) });
  }
};
