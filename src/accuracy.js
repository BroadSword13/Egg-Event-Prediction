(function (root) {
  'use strict';
  const app = root.EggEventLab;
  const { MODEL_ORDER, NON_ULTRA_MIDWEEK_POOL, ULTRA_MIDWEEK_POOL, APP_VERSION } = app.config;
  const { addDays, diffDays } = app.utils;
  function normalize(raw) {
    const out = {};
    for (const [date, item] of Object.entries(raw || {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !item || item.reference !== addDays(date, -1)
          || !Number.isFinite(Date.parse(item.savedAt)) || app.utils.eventDateForInstant(new Date(item.savedAt)) >= date
          || !MODEL_ORDER.every(id => Number.isFinite(item.probabilities?.[id]) && item.probabilities[id] >= 0 && item.probabilities[id] <= 1)) continue;
      out[date] = { reference: item.reference, savedAt: item.savedAt, version: String(item.version || ''), probabilities: Object.fromEntries(MODEL_ORDER.map(id => [id, item.probabilities[id]])) };
    }
    return out;
  }
  function save(date, probabilities) {
    // Only tomorrow's one-day forecast can become a genuine pre-release record.
    const today = app.clock.currentEventDate();
    if (date !== addDays(today, 1) || date.slice(5) === '07-14' || !probabilities) return;
    const state = app.store.getState();
    if (Object.hasOwn(app.store.getConfirmedDays(), date)) return;
    const item = { reference: today, savedAt: app.clock.now().toISOString(), version: APP_VERSION,
      probabilities: Object.fromEntries(MODEL_ORDER.map(id => [id, Number(probabilities[id] || 0)])) };
    const valid = normalize({ [date]: item });
    if (!valid[date]) return;
    // Keep the last forecast actually produced before release; never rewrite after release.
    state.predictionArchive = { ...(state.predictionArchive || {}), ...valid };
    app.store.saveState();
  }
  function summarize(days = 90, source = null) {
    const today = source?.today || app.clock.currentEventDate(), confirmed = source?.confirmed || app.store.getConfirmedDays();
    const results = { nonUltra: [], ultra: [], capacity: [] };
    for (const [date, item] of Object.entries(normalize(source?.archive || app.store.getState().predictionArchive))) {
      if (date > today || diffDays(date, today) >= days || !Object.hasOwn(confirmed, date) || date.slice(5) === '07-14') continue;
      const actual = confirmed[date], p = item.probabilities;
      for (const [key, pool] of [['nonUltra', [...NON_ULTRA_MIDWEEK_POOL]], ['ultra', [...ULTRA_MIDWEEK_POOL, 'capacity_pink']]]) {
        if (key === 'nonUltra' && app.model.fixedNonUltraEvent(date)) continue;
        const sum = pool.reduce((s,id) => s + p[id], 0);
        const hits = pool.filter(id => actual.includes(id));
        if (hits.length > 1 || (sum < 0.000001 && !hits.length)) continue;
        const probs = [...pool.map(id => p[id]), Math.max(0, 1-sum)];
        const target = hits.length ? pool.indexOf(hits[0]) : pool.length;
        const loss = probs.reduce((s,v,i) => s + (v - Number(i === target)) ** 2, 0) / 2;
        const ranked = probs.map((v,i) => ({v,i})).sort((a,b) => b.v-a.v);
        results[key].push({ loss, top: ranked[0].i === target, top3: ranked.slice(0,3).some(x=>x.i===target) });
      }
      if (new Date(date+'T12:00:00Z').getUTCDay() === 0) results.capacity.push({ loss: (p.capacity_purple - Number(actual.includes('capacity_purple'))) ** 2 });
    }
    const stats = rows => ({ count: rows.length, score: rows.length ? 100*(1-rows.reduce((s,r)=>s+r.loss,0)/rows.length) : null,
      top: rows.length ? rows.filter(r=>r.top).length/rows.length : null, top3: rows.length ? rows.filter(r=>r.top3).length/rows.length : null });
    return { overall: stats([...results.nonUltra,...results.ultra]), ...Object.fromEntries(Object.entries(results).map(([k,v])=>[k,stats(v)])) };
  }
  app.accuracy = { normalize, save, summarize };
})(typeof window !== 'undefined' ? window : globalThis);
