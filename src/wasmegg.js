(function (root) {
  'use strict';

  const {
    MODEL_ORDER,
    DEFAULT_REMOTE,
    SHARED_EVENTS_URL,
    REMOTE_DATA_START,
    REMOTE_SCHEMA_VERSION
  } = root.EggEventLab.config;
  const { addDays, isAnniversaryDate, isoDate } = root.EggEventLab.utils;
  const store = root.EggEventLab.store;

  function unixToIsoUTC(seconds) {
    const date = new Date(Number(seconds) * 1000);
    if (!Number.isFinite(date.getTime())) return null;
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function mapWasmeggEvent(row) {
    const ultra = Boolean(row.ultra);
    if (row.type === 'hab-sale') return ultra ? 'housing_pink' : 'housing_blue';
    if (row.type === 'vehicle-sale') return ultra ? 'shipping_pink' : 'shipping_blue';
    if (row.type === 'drone-boost') return ultra ? 'drone_pink' : 'drone_green';
    if (row.type === 'mission-capacity' && Number(row.multiplier) === 2) return ultra ? 'capacity_pink' : 'capacity_purple';
    if (row.type === 'boost-duration' && Number(row.multiplier) === 2) return ultra ? 'blocker_ultra_boost_duration' : 'blocker_boost_duration';
    if (row.type === 'gift-boost' && Number(row.multiplier) === 2) return ultra ? 'blocker_ultra_gifts' : 'blocker_gifts';
    if (row.type === 'shell-sale' && Math.abs(Number(row.multiplier) - 0.85) < 0.001) return ultra ? 'blocker_ultra_shells' : 'blocker_shells';
    if (row.type === 'mission-fuel' && Number(row.multiplier) === 3) return ultra ? 'blocker_ultra_fueling' : 'blocker_fueling';
    return null;
  }

  function normalizeWasmeggData(rows, today = (root.EggEventLab.clock?.currentEventDate?.() || isoDate(new Date()))) {
    if (!Array.isArray(rows)) throw new Error('Wasmegg returned an unexpected data format.');

    const events = Object.fromEntries(MODEL_ORDER.map(id => [id, []]));
    const eventSets = Object.fromEntries(MODEL_ORDER.map(id => [id, new Set()]));
    let latestObserved = null;

    for (const row of rows) {
      if (!row || row.startTimestamp == null) continue;
      const date = unixToIsoUTC(row.startTimestamp);
      if (!date || date < REMOTE_DATA_START || date > today) continue;
      if (!latestObserved || date > latestObserved) latestObserved = date;
      const id = mapWasmeggEvent(row);
      if (!id || isAnniversaryDate(date)) continue;
      eventSets[id].add(date);
    }

    MODEL_ORDER.forEach(id => {
      events[id] = [...eventSets[id]].sort();
    });

    if (!latestObserved) throw new Error('Wasmegg did not contain any observed event dates.');

    const confirmedDays = {};
    for (let date = REMOTE_DATA_START; date <= latestObserved; date = addDays(date, 1)) {
      confirmedDays[date] = MODEL_ORDER.filter(id => eventSets[id].has(date));
    }

    return { events, confirmedDays, latestDate: latestObserved };
  }

  function auditSeedAgainstRemote(remoteEvents, seedEvents = root.EggEventLab.seed?.SEED_EVENTS || {}) {
    const seedOnly = {};
    const remoteOnly = {};

    for (const id of MODEL_ORDER) {
      const remote = new Set(remoteEvents?.[id] || []);
      const seed = new Set((seedEvents?.[id] || []).filter(date => !isAnniversaryDate(date)));
      const badSeedDates = [...seed].filter(date => !remote.has(date)).sort();
      const missingSeedDates = [...remote].filter(date => !seed.has(date)).sort();

      if (badSeedDates.length) seedOnly[id] = badSeedDates;
      if (missingSeedDates.length) remoteOnly[id] = missingSeedDates;
    }

    return {
      ok: Object.keys(seedOnly).length === 0,
      seedOnly,
      remoteOnly,
      seedCount: Object.values(seedEvents || {}).reduce((sum, dates) => sum + (Array.isArray(dates) ? dates.filter(date => !isAnniversaryDate(date)).length : 0), 0),
      remoteCount: Object.values(remoteEvents || {}).reduce((sum, dates) => sum + (Array.isArray(dates) ? dates.length : 0), 0)
    };
  }

  async function sync() {
    const state = store.getState();
    try {
      const response = await fetch(SHARED_EVENTS_URL, {
        cache: 'no-cache',
        signal: AbortSignal.timeout(15000),
        mode: 'cors'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const rows = await response.json();
      const normalized = normalizeWasmeggData(rows);
      const seedAudit = auditSeedAgainstRemote(normalized.events);
      if (!seedAudit.ok && typeof console !== 'undefined') {
        console.warn('Bundled fallback seed differs from Wasmegg:', seedAudit.seedOnly);
      }
      state.remote = {
        ...state.remote,
        ...normalized,
        syncedAt: new Date().toISOString(),
        lastError: null,
        source: SHARED_EVENTS_URL,
        rangeStart: REMOTE_DATA_START,
        schemaVersion: REMOTE_SCHEMA_VERSION,
        seedAudit: {
          ok: seedAudit.ok,
          seedOnly: seedAudit.seedOnly,
          seedCount: seedAudit.seedCount,
          remoteCount: seedAudit.remoteCount
        }
      };
      store.saveState();
      return { ok: true, ...normalized };
    } catch (error) {
      state.remote ||= store.clone(DEFAULT_REMOTE);
      state.remote.lastError = error?.message || String(error);
      store.saveState();
      return { ok: false, error: state.remote.lastError };
    }
  }

  root.EggEventLab.wasmegg = {
    unixToIsoUTC,
    mapWasmeggEvent,
    normalizeWasmeggData,
    auditSeedAgainstRemote,
    sync
  };
})(typeof window !== 'undefined' ? window : globalThis);
