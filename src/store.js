(function (root) {
  'use strict';

  const {
    STORAGE_KEY,
    TODAY_SEED,
    REMOTE_DATA_START,
    REMOTE_SCHEMA_VERSION,
    ORDER,
    MAIN_ORDER,
    CORE_DAILY_ORDER,
    CAPACITY_ORDER,
    MODEL_ORDER,
    BLOCKER_ORDER,
    ULTRA_CADENCE_POOL,
    ULTRA_CADENCE_START,
    ULTRA_CADENCE_INTERVAL_DAYS,
    DEFAULT_SETTINGS,
    DEFAULT_UI,
    DEFAULT_REMOTE
  } = root.EggEventLab.config;
  const { SEED_EVENTS, SEED_CONFIRMED_DAYS } = root.EggEventLab.seed;
  const { addDays, clamp, diffDays, isAnniversaryDate, isoDate, parseDate } = root.EggEventLab.utils;

  function createStore(initialState = null, cutoff = null) {

  function clone(value) {
    return typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  function defaultState() {
    return {
      overrides: {},
      settings: clone(DEFAULT_SETTINGS),
      ui: clone(DEFAULT_UI),
      remote: clone(DEFAULT_REMOTE)
    };
  }

  function normalizeWeights(rawWeights = {}) {
    return {
      under1: Number(rawWeights.under1 ?? rawWeights[2026] ?? DEFAULT_SETTINGS.weights.under1),
      oneToTwo: Number(rawWeights.oneToTwo ?? rawWeights[2025] ?? DEFAULT_SETTINGS.weights.oneToTwo),
      twoPlus: Number(rawWeights.twoPlus ?? rawWeights[2024] ?? DEFAULT_SETTINGS.weights.twoPlus)
    };
  }

  function migrateLegacyOverrides(overrides = {}, remoteConfirmedDays = null, legacy = true) {
    if (!legacy) return clone(overrides || {});
    const migrated = clone(overrides || {});
    for (const [date, tracked] of Object.entries(migrated)) {
      const sourceDay = remoteConfirmedDays?.[date] || SEED_CONFIRMED_DAYS[date] || [];
      const previouslyRemoteOnly = sourceDay.filter(id => BLOCKER_ORDER.includes(id));
      migrated[date] = [...new Set([...(Array.isArray(tracked) ? tracked : []), ...previouslyRemoteOnly])];
    }
    return migrated;
  }

  function readStorage() {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
  }

  function writeStorage(value) {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, value);
  }

  function removeStorage() {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
  }

  function loadState() {
    try {
      const raw = readStorage();
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const rawSavedEvents = Array.isArray(parsed.ui?.forecastEvents) ? parsed.ui.forecastEvents : null;
      const selectionVersion = Number(parsed.ui?.forecastSelectionVersion || 1);
      let savedEvents = rawSavedEvents
        ? rawSavedEvents.filter(id => MAIN_ORDER.includes(id))
        : [...DEFAULT_UI.forecastEvents];
      const previousUnifiedDefault = selectionVersion < DEFAULT_UI.forecastSelectionVersion
        && rawSavedEvents
        && rawSavedEvents.length === MAIN_ORDER.length
        && MAIN_ORDER.every(id => rawSavedEvents.includes(id));
      if (previousUnifiedDefault) savedEvents = [...DEFAULT_UI.forecastEvents];
      const savedCapacityEvents = Array.isArray(parsed.ui?.capacityEvents)
        ? parsed.ui.capacityEvents.filter(id => CAPACITY_ORDER.includes(id))
        : rawSavedEvents
          ? rawSavedEvents.filter(id => CAPACITY_ORDER.includes(id))
          : [...CAPACITY_ORDER];

      const remote = {
        ...clone(DEFAULT_REMOTE),
        ...(parsed.remote || {}),
        autoSync: parsed.remote?.autoSync !== false
      };

      if (remote.rangeStart !== REMOTE_DATA_START || remote.schemaVersion !== REMOTE_SCHEMA_VERSION) {
        Object.assign(remote, clone(DEFAULT_REMOTE), { autoSync: remote.autoSync });
      }

      return {
        overrides: migrateLegacyOverrides(parsed.overrides || {}, remote.confirmedDays, parsed.ui?.unifiedDailyEvents !== true),
        settings: {
          ...clone(DEFAULT_SETTINGS),
          ...(parsed.settings || {}),
          weights: normalizeWeights(parsed.settings?.weights || {})
        },
        ui: {
          ...clone(DEFAULT_UI),
          ...(parsed.ui || {}),
          unifiedDailyEvents: true,
          forecastDays: clamp(Number(parsed.ui?.forecastDays || 7), 1, 120),
          forecastSelectionVersion: DEFAULT_UI.forecastSelectionVersion,
          forecastEvents: savedEvents.length ? savedEvents : [...DEFAULT_UI.forecastEvents],
          capacityWeeks: clamp(Number(parsed.ui?.capacityWeeks || 4), 1, 52),
          capacityEvents: savedCapacityEvents.length ? savedCapacityEvents : [...CAPACITY_ORDER],
          calendarShowConfirmed: parsed.ui?.calendarShowConfirmed !== false,
          calendarShowPredictions: parsed.ui?.calendarShowPredictions !== false,
          calendarShowNonUltra: parsed.ui?.calendarShowNonUltra !== false,
          calendarShowUltra: parsed.ui?.calendarShowUltra !== false,
          calendarMinProbability: clamp(Number(parsed.ui?.calendarMinProbability ?? DEFAULT_UI.calendarMinProbability), 0, 100)
        },
        remote
      };
    } catch {
      return defaultState();
    }
  }

  let state = initialState || loadState();

  function getState() {
    return state;
  }

  function replaceState(nextState) {
    state = nextState;
  }

  function saveState() {
    writeStorage(JSON.stringify(state));
  }

  function resetState() {
    removeStorage();
    state = loadState();
    return state;
  }

  function hasRemoteData() {
    return Boolean(state.remote?.syncedAt && state.remote?.events);
  }

  function baseEventDates(eventId) {
    if (hasRemoteData() && Array.isArray(state.remote.events?.[eventId])) {
      return state.remote.events[eventId];
    }
    return SEED_EVENTS[eventId] || [];
  }

  function getConfirmedDays() {
    const remoteConfirmed = hasRemoteData() && state.remote.confirmedDays
      ? state.remote.confirmedDays
      : {};
    const merged = { ...SEED_CONFIRMED_DAYS, ...remoteConfirmed };

    Object.entries(state.overrides).forEach(([date, tracked]) => {
      merged[date] = [...tracked];
    });

    return Object.fromEntries(Object.entries(merged).filter(([date]) => !cutoff || date <= cutoff));
  }

  function getAllEventDates(eventId) {
    const dates = new Set(baseEventDates(eventId));

    if (ORDER.includes(eventId)) {
      Object.entries(state.overrides).forEach(([date, events]) => {
        dates.delete(date);
        if (events.includes(eventId)) dates.add(date);
      });
    }

    return [...dates].filter(date => !cutoff || date <= cutoff).sort();
  }

  function modelDates(eventId) {
    return getAllEventDates(eventId).filter(date => !isAnniversaryDate(date));
  }

  function eventMapForCalendar() {
    const map = {};
    ORDER.forEach(id => getAllEventDates(id).forEach(date => {
      (map[date] ||= []).push(id);
    }));
    return map;
  }

  function latestConfirmedDay() {
    const keys = Object.keys(getConfirmedDays()).sort();
    return keys[keys.length - 1] || TODAY_SEED;
  }

  function latestDataDate() {
    const all = MODEL_ORDER.flatMap(getAllEventDates).concat(Object.keys(getConfirmedDays()));
    return all.sort().at(-1) || TODAY_SEED;
  }

  function lastEventBefore(eventId, targetDate, simulatedHistory = null) {
    const base = simulatedHistory?.[eventId] || modelDates(eventId);
    let last = null;
    for (const date of base) {
      if (date < targetDate) last = date;
      else break;
    }
    return last;
  }

  function lastEventOnOrBefore(eventId, targetDate, simulatedHistory = null) {
    return lastEventBefore(eventId, addDays(targetDate, 1), simulatedHistory);
  }

  function historicalGaps(eventId, beforeDate = '9999-12-31') {
    const dates = modelDates(eventId).filter(date => date < beforeDate);
    const gaps = [];
    for (let index = 1; index < dates.length; index += 1) {
      const startDate = dates[index - 1];
      const endDate = dates[index];
      const gap = diffDays(startDate, endDate);

      // Since May 4, 2026 the regular Ultra slot follows an every-other-day
      // cadence. Odd same-rotation gaps from that regime are anniversary /
      // phase-shift artifacts and are intentionally excluded from training.
      const usesUltraCadence = ULTRA_CADENCE_POOL.has(eventId);
      const inCadenceEra = endDate >= ULTRA_CADENCE_START;
      const alignsWithCadence = gap % ULTRA_CADENCE_INTERVAL_DAYS === 0;
      if (usesUltraCadence && inCadenceEra && !alignsWithCadence) continue;

      gaps.push({ gap, endDate });
    }
    return gaps;
  }

  function recencyWeight(endDate, referenceDate) {
    const ref = parseDate(referenceDate || latestDataDate());
    const oneYearAgo = new Date(ref);
    const twoYearsAgo = new Date(ref);
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const cutoff1 = isoDate(oneYearAgo);
    const cutoff2 = isoDate(twoYearsAgo);

    if (endDate > cutoff1) return Number(state.settings.weights.under1 ?? 3);
    if (endDate > cutoff2) return Number(state.settings.weights.oneToTwo ?? 2);
    return Number(state.settings.weights.twoPlus ?? 0.5);
  }

  function gapStats(eventId, beforeDate = '9999-12-31') {
    const gaps = historicalGaps(eventId, beforeDate);
    const referenceDate = beforeDate === '9999-12-31' ? latestDataDate() : beforeDate;
    const byGap = new Map();

    for (const row of gaps) {
      const current = byGap.get(row.gap) || { gap: row.gap, count: 0, weighted: 0 };
      current.count += 1;
      current.weighted += recencyWeight(row.endDate, referenceDate);
      byGap.set(row.gap, current);
    }

    return [...byGap.values()].sort((a, b) => a.gap - b.gap);
  }

  return {
    createStore,
    clone,
    defaultState,
    normalizeWeights,
    migrateLegacyOverrides,
    getState,
    replaceState,
    saveState,
    resetState,
    hasRemoteData,
    baseEventDates,
    getConfirmedDays,
    getAllEventDates,
    modelDates,
    eventMapForCalendar,
    latestConfirmedDay,
    latestDataDate,
    lastEventBefore,
    lastEventOnOrBefore,
    historicalGaps,
    recencyWeight,
    gapStats
  };
  }
  root.EggEventLab.store = createStore();
})(typeof window !== 'undefined' ? window : globalThis);
