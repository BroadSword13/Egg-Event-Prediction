(function (root) {
  'use strict';

  const {
    EVENTS,
    ORDER,
    NON_ULTRA_BLOCKER_ORDER,
    ULTRA_BLOCKER_ORDER,
    BLOCKER_ORDER,
    MODEL_ORDER,
    CAPACITY_ORDER,
    NON_ULTRA_CORE,
    ULTRA_CORE,
    NON_ULTRA_MIDWEEK_POOL,
    ULTRA_MIDWEEK_POOL,
    ULTRA_DAILY_POOL,
    ULTRA_CADENCE_POOL,
    ULTRA_CADENCE_START,
    ULTRA_CADENCE_INTERVAL_DAYS,
    SIM_RUNS,
    NEXT_HIT_RUNS,
    NEXT_DATE_HORIZON,
    MAIN_NEXT_DATE_HORIZON,
    SUNDAY_ROTATION_ANCHOR
  } = root.EggEventLab.config;
  const {
    addDays,
    clamp,
    diffDays,
    hashString,
    isAnniversaryDate,
    mulberry32,
    parseDate
  } = root.EggEventLab.utils;
  const store = root.EggEventLab.store;

  const FIXED_NON_ULTRA = {
    1: { label: '2× Earnings', short: '2× Earnings', icon: '💰', color: 'gold', family: 'earnings' },
    5: { label: '70% Off Common Research', short: '70% Off Research', icon: '🔬', color: 'teal', family: 'research' },
    6: { label: 'Prestige Bonus', short: 'Prestige Bonus', icon: '⭐', color: 'purple', family: 'prestige', note: 'Usually 2×; special multipliers can occur.' }
  };

  // Hot-path caches. Forecast simulations evaluate the same event/date pairs
  // thousands of times, so eligibility and deadline checks should be computed
  // once per model state rather than once per simulation run.
  const ultraCadenceCache = new Map();
  const allowedWeekdayCache = new Map();
  const eligibleGapCache = new Map();


  function fixedNonUltraEvent(dateStr) {
    if (isAnniversaryDate(dateStr)) return null;
    const dayOfWeek = parseDate(dateStr).getDay();
    if (dayOfWeek !== 0) return FIXED_NON_ULTRA[dayOfWeek] ? { ...FIXED_NON_ULTRA[dayOfWeek] } : null;

    const weekOffset = Math.round(diffDays(SUNDAY_ROTATION_ANCHOR, dateStr) / 7);
    const isCrafting = ((weekOffset % 2) + 2) % 2 === 0;
    return isCrafting
      ? { label: '30% Off Crafting', short: '30% Off Crafting', icon: '🛠️', color: 'amber', family: 'crafting' }
      : { label: '35% Off Epic Research', short: '35% Off Epic Research', icon: '📚', color: 'gold', family: 'epic-research' };
  }

  function highestProbability(probabilities, ids) {
    let best = null;
    for (const id of ids) {
      const probability = Number(probabilities?.[id] || 0);
      if (!best || probability > best.probability) best = { id, probability };
    }
    return best;
  }

  function latestUltraCadenceDate(beforeDate = '9999-12-31') {
    let latest = null;
    for (const id of ULTRA_CADENCE_POOL) {
      for (const date of store.modelDates(id)) {
        if (date < ULTRA_CADENCE_START || date >= beforeDate) continue;
        if (!latest || date > latest) latest = date;
      }
    }
    return latest;
  }

  function isUltraCadenceDate(dateStr) {
    if (dateStr < ULTRA_CADENCE_START) return true;
    if (isAnniversaryDate(dateStr)) return false;
    if (ultraCadenceCache.has(dateStr)) return ultraCadenceCache.get(dateStr);

    const anchor = latestUltraCadenceDate(dateStr) || ULTRA_CADENCE_START;
    const eligible = diffDays(anchor, dateStr) % ULTRA_CADENCE_INTERVAL_DAYS === 0;
    ultraCadenceCache.set(dateStr, eligible);
    return eligible;
  }

  function allowedWeekday(eventId, dateStr) {
    const state = store.getState();
    const key = `${eventId}|${dateStr}|${state.settings.weekdayPattern ? 1 : 0}`;
    if (allowedWeekdayCache.has(key)) return allowedWeekdayCache.get(key);

    const event = EVENTS[eventId];
    const dayOfWeek = parseDate(dateStr).getDay();
    let allowed = true;

    if (event.sundayOnly && dayOfWeek !== 0) allowed = false;
    else if (ULTRA_CADENCE_POOL.has(eventId) && !isUltraCadenceDate(dateStr)) allowed = false;
    else if (state.settings.weekdayPattern && event.weekdayObserved) allowed = [2, 3, 4].includes(dayOfWeek);

    allowedWeekdayCache.set(key, allowed);
    return allowed;
  }

  function latestEligibleGap(eventId, lastDate) {
    const event = EVENTS[eventId];
    const state = store.getState();
    if (!event.maxGap || !state.settings.cap16) return null;

    const key = `${eventId}|${lastDate}|${state.settings.weekdayPattern ? 1 : 0}`;
    if (eligibleGapCache.has(key)) return eligibleGapCache.get(key);

    let lastGap = null;
    for (let gap = event.minGap || 1; gap <= event.maxGap; gap += 1) {
      if (allowedWeekday(eventId, addDays(lastDate, gap))) lastGap = gap;
    }
    eligibleGapCache.set(key, lastGap);
    return lastGap;
  }

  function hazard(eventId, targetDate, simulatedHistory = null) {
    const event = EVENTS[eventId];
    const state = store.getState();
    if (!allowedWeekday(eventId, targetDate)) return 0;

    const last = store.lastEventBefore(eventId, targetDate, simulatedHistory);
    if (!last) return 0;

    const gap = diffDays(last, targetDate);
    if (event.minGap && gap < event.minGap) return 0;
    if (state.settings.pink5 && event.tier === 'ultra' && gap === 5) return 0;

    if (state.settings.cap16 && event.maxGap) {
      const deadline = latestEligibleGap(eventId, last);
      if (deadline != null && gap > deadline) return 0;
      if (deadline != null && gap === deadline) return 1;
    }

    const stats = store.gapStats(eventId, targetDate);
    const exact = stats.find(row => row.gap === gap)?.weighted || 0;
    const survivor = stats
      .filter(row => row.gap >= gap)
      .reduce((sum, row) => sum + row.weighted, 0);

    if (survivor <= 0) return event.sparse ? 0.015 : 0;

    let probability = exact / survivor;
    if (event.sparse) probability = Math.max(probability, 0.02);
    return clamp(probability, 0, 1);
  }

  function hazardFast(eventId, targetDate, lastDate, stats) {
    const event = EVENTS[eventId];
    const state = store.getState();
    if (!allowedWeekday(eventId, targetDate) || !lastDate) return 0;

    const gap = diffDays(lastDate, targetDate);
    if (event.minGap && gap < event.minGap) return 0;
    if (state.settings.pink5 && event.tier === 'ultra' && gap === 5) return 0;

    if (state.settings.cap16 && event.maxGap) {
      const deadline = latestEligibleGap(eventId, lastDate);
      if (deadline != null && gap > deadline) return 0;
      if (deadline != null && gap === deadline) return 1;
    }

    const exact = stats.exact.get(gap) || 0;
    const survivor = stats.survivor.get(gap) || 0;
    if (survivor <= 0) return event.sparse ? 0.015 : 0;

    let probability = exact / survivor;
    if (event.sparse) probability = Math.max(probability, 0.02);
    return clamp(probability, 0, 1);
  }

  function conflicts(a, b) {
    // Tuesday-Thursday has one shared Non-Ultra slot. Housing, shipping,
    // drones, boost duration, gifts, shells, and fueling therefore compete
    // with every other member of the Non-Ultra midweek pool.
    if (NON_ULTRA_MIDWEEK_POOL.has(a) && NON_ULTRA_MIDWEEK_POOL.has(b)) return true;

    const ultraBlockerConflict =
      (ULTRA_CORE.has(a) && ULTRA_BLOCKER_ORDER.includes(b)) ||
      (ULTRA_CORE.has(b) && ULTRA_BLOCKER_ORDER.includes(a));
    if (ultraBlockerConflict) return true;

    const sameFamily = EVENTS[a].family === EVENTS[b].family;
    const differentTier = EVENTS[a].tier !== EVENTS[b].tier;
    if (sameFamily && differentTier) return true;

    return false;
  }

  function buildStatCache(eventId, beforeDate) {
    const rows = store.gapStats(eventId, beforeDate);
    const exact = new Map(rows.map(row => [row.gap, row.weighted]));
    const survivor = new Map();
    const maxObserved = rows.length ? Math.max(...rows.map(row => row.gap)) : 0;

    for (let gap = 0; gap <= maxObserved; gap += 1) {
      let total = 0;
      for (const row of rows) {
        if (row.gap >= gap) total += row.weighted;
      }
      survivor.set(gap, total);
    }

    return { rows, exact, survivor };
  }

  function resolveConflicts(triggered, probabilities, random) {
    let active = [...triggered];
    let guard = 0;

    while (guard < 20) {
      guard += 1;
      let pair = null;
      outer: for (let first = 0; first < active.length; first += 1) {
        for (let second = first + 1; second < active.length; second += 1) {
          if (conflicts(active[first], active[second])) {
            pair = [active[first], active[second]];
            break outer;
          }
        }
      }

      if (!pair) break;
      const [a, b] = pair;
      const weightA = Math.max(probabilities[a], 0.001);
      const weightB = Math.max(probabilities[b], 0.001);
      const loser = random() < weightA / (weightA + weightB) ? b : a;
      active = active.filter(id => id !== loser);
    }

    return active;
  }

  function nonUltraCandidatesForDate(dateStr, activeOrder = MODEL_ORDER) {
    if (isAnniversaryDate(dateStr)) return [];
    const dayOfWeek = parseDate(dateStr).getDay();
    if (![2, 3, 4].includes(dayOfWeek)) return [];
    const activeSet = new Set(activeOrder);
    return [...NON_ULTRA_MIDWEEK_POOL].filter(id => activeSet.has(id) && allowedWeekday(id, dateStr));
  }

  function ultraCandidatesForDate(dateStr, activeOrder = MODEL_ORDER) {
    if (dateStr < ULTRA_CADENCE_START || !isUltraCadenceDate(dateStr) || isAnniversaryDate(dateStr)) return [];
    const activeSet = new Set(activeOrder);
    return [...ULTRA_CADENCE_POOL].filter(id => activeSet.has(id) && allowedWeekday(id, dateStr));
  }

  function weightedChoice(ids, weights, random, statCache = null) {
    if (!ids.length) return null;
    const sanitized = ids.map(id => Math.max(Number(weights[id] || 0), 0));
    let total = sanitized.reduce((sum, value) => sum + value, 0);

    // A guaranteed slot is known to contain one event. If all gap hazards
    // happen to be zero (for example after a newly observed schedule change),
    // fall back to each rotation's cached weighted historical support instead of
    // incorrectly inventing a no-event outcome.
    if (total <= 0) {
      ids.forEach((id, index) => {
        const rows = statCache?.[id]?.rows || store.gapStats(id);
        const support = rows.reduce((sum, row) => sum + row.weighted, 0);
        sanitized[index] = Math.max(support, 0.001);
      });
      total = sanitized.reduce((sum, value) => sum + value, 0);
    }

    let roll = random() * total;
    for (let index = 0; index < ids.length; index += 1) {
      roll -= sanitized[index];
      if (roll <= 0) return ids[index];
    }
    return ids.at(-1);
  }

  function candidateWeight(id, probabilities, statCache) {
    const direct = Math.max(Number(probabilities[id] || 0), 0);
    if (direct > 0) return direct;
    const support = statCache?.[id]?.rows?.reduce((sum, row) => sum + row.weighted, 0) || 0;
    return Math.max(support, 0.001);
  }

  function weightedCompatiblePair(nonUltraIds, ultraIds, probabilities, statCache, random) {
    const pairs = [];
    let total = 0;
    const nonUltraWeights = Object.fromEntries(nonUltraIds.map(id => [id, candidateWeight(id, probabilities, statCache)]));
    const ultraWeights = Object.fromEntries(ultraIds.map(id => [id, candidateWeight(id, probabilities, statCache)]));

    for (const nonUltra of nonUltraIds) {
      for (const ultra of ultraIds) {
        if (conflicts(nonUltra, ultra)) continue;
        const weight = nonUltraWeights[nonUltra] * ultraWeights[ultra];
        pairs.push({ nonUltra, ultra, weight });
        total += weight;
      }
    }

    if (!pairs.length) return { nonUltra: null, ultra: null };
    let roll = random() * total;
    for (const pair of pairs) {
      roll -= pair.weight;
      if (roll <= 0) return pair;
    }
    return pairs.at(-1);
  }

  function sampleActiveEvents(date, activeOrder, last, statCache, random) {
    const probabilities = {};
    const triggered = [];
    const nonUltraCandidates = nonUltraCandidatesForDate(date, activeOrder);
    const ultraCandidates = ultraCandidatesForDate(date, activeOrder);
    const guaranteedSet = new Set([...nonUltraCandidates, ...ultraCandidates]);

    for (const id of activeOrder) {
      const probability = hazardFast(id, date, last[id], statCache[id]);
      probabilities[id] = probability;
      if (guaranteedSet.has(id)) continue;
      if (random() < probability) triggered.push(id);
    }

    let guaranteedNonUltra = null;
    let guaranteedUltra = null;

    if (nonUltraCandidates.length && ultraCandidates.length) {
      const pair = weightedCompatiblePair(nonUltraCandidates, ultraCandidates, probabilities, statCache, random);
      guaranteedNonUltra = pair.nonUltra;
      guaranteedUltra = pair.ultra;
    } else if (nonUltraCandidates.length) {
      guaranteedNonUltra = weightedChoice(nonUltraCandidates, probabilities, random, statCache);
    } else if (ultraCandidates.length) {
      guaranteedUltra = weightedChoice(ultraCandidates, probabilities, random, statCache);
    }

    // Guaranteed daily slots cannot be removed by independently triggered events.
    // Filter conflicts against both slots first, then resolve any remaining optional
    // event conflicts normally.
    const guaranteed = [guaranteedNonUltra, guaranteedUltra].filter(Boolean);
    const compatibleTriggered = triggered.filter(id => guaranteed.every(fixed => !conflicts(id, fixed)));
    const active = resolveConflicts(compatibleTriggered, probabilities, random);
    active.push(...guaranteed);

    return { active, probabilities };
  }

  let nextHitCacheKey = null;
  let nextHitCacheValue = null;
  const forecastCache = new Map();
  const capacityForecastCache = new Map();

  function invalidateNextHitCache() {
    nextHitCacheKey = null;
    nextHitCacheValue = null;
    ultraCadenceCache.clear();
    allowedWeekdayCache.clear();
    eligibleGapCache.clear();
    forecastCache.clear();
    capacityForecastCache.clear();
  }

  function simulationFingerprint(startDate) {
    const state = store.getState();
    return `${startDate}|${JSON.stringify(state.settings)}|${JSON.stringify(state.overrides)}|${state.remote?.syncedAt || 'seed'}`;
  }

  function nextHitSeed(startDate) {
    const state = store.getState();
    return hashString(`next-hit|${startDate}${JSON.stringify(state.settings)}${JSON.stringify(state.overrides)}|${state.remote?.syncedAt || 'seed'}`);
  }

  function forecastSeed(startDate) {
    const state = store.getState();
    return hashString(`${startDate}${JSON.stringify(state.settings)}${JSON.stringify(state.overrides)}|${state.remote?.syncedAt || 'seed'}`);
  }

  function simulationRunRandom(baseSeed, run) {
    return mulberry32(hashString(`${baseSeed}|run:${run}`));
  }

  function simulateFirstHitPool(startDate, dateList, activeOrder, targetOrder, seedLabel, runs = NEXT_HIT_RUNS) {
    const firstDate = addDays(startDate, 1);
    const confirmed = store.getConfirmedDays();
    const counts = Object.fromEntries(targetOrder.map(id => [id, new Map()]));
    const hitTotals = Object.fromEntries(targetOrder.map(id => [id, 0]));
    const state = store.getState();
    const baseSeed = hashString(`${seedLabel}|${startDate}|${JSON.stringify(state.settings)}|${JSON.stringify(state.overrides)}|${state.remote?.syncedAt || 'seed'}`);

    const statCache = {};
    const initialLast = {};
    activeOrder.forEach(id => {
      statCache[id] = buildStatCache(id, firstDate);
      initialLast[id] = store.lastEventBefore(id, firstDate) || store.modelDates(id).filter(date => date < firstDate).at(-1) || null;
    });

    for (let run = 0; run < runs; run += 1) {
      const random = simulationRunRandom(baseSeed, run);
      const last = { ...initialLast };
      const firstSeen = new Set();

      for (const date of dateList) {
        if (isAnniversaryDate(date)) continue;

        let active = [];
        if (confirmed[date]) {
          active = confirmed[date].filter(id => activeOrder.includes(id));
        } else {
          active = sampleActiveEvents(date, activeOrder, last, statCache, random).active;
        }

        for (const id of active) {
          if (counts[id] && !firstSeen.has(id)) {
            firstSeen.add(id);
            counts[id].set(date, (counts[id].get(date) || 0) + 1);
            hitTotals[id] += 1;
          }
          last[id] = date;
        }

        if (firstSeen.size === targetOrder.length) break;
      }
    }

    return Object.fromEntries(targetOrder.map(id => {
      let bestDate = null;
      let bestCount = 0;
      for (const [date, count] of counts[id]) {
        if (count > bestCount || (count === bestCount && (!bestDate || date < bestDate))) {
          bestDate = date;
          bestCount = count;
        }
      }

      const last = initialLast[id];
      return [id, {
        date: bestDate,
        probability: bestCount / runs,
        coverage: hitTotals[id] / runs,
        gap: bestDate && last ? diffDays(last, bestDate) : null,
        horizon: dateList.length ? diffDays(startDate, dateList.at(-1)) : 0
      }];
    }));
  }

  function simulateCapacityFirstHitForecast(startDate, dateList, runs = NEXT_HIT_RUNS) {
    const firstDate = addDays(startDate, 1);
    const confirmed = store.getConfirmedDays();
    const counts = Object.fromEntries(CAPACITY_ORDER.map(id => [id, new Map()]));
    const hitTotals = Object.fromEntries(CAPACITY_ORDER.map(id => [id, 0]));
    const state = store.getState();
    const baseSeed = hashString(`next-capacity|${startDate}|${JSON.stringify(state.settings)}|${JSON.stringify(state.overrides)}|${state.remote?.syncedAt || 'seed'}`);

    const statCache = {};
    const initialLast = {};
    CAPACITY_ORDER.forEach(id => {
      statCache[id] = buildStatCache(id, firstDate);
      initialLast[id] = store.lastEventBefore(id, firstDate) || store.modelDates(id).filter(date => date < firstDate).at(-1) || null;
    });

    for (let run = 0; run < runs; run += 1) {
      const random = simulationRunRandom(baseSeed, run);
      const last = { ...initialLast };
      const firstSeen = new Set();

      for (const date of dateList) {
        if (isAnniversaryDate(date)) continue;

        let active = [];
        if (confirmed[date]) {
          active = confirmed[date].filter(id => CAPACITY_ORDER.includes(id));
        } else {
          const probabilities = {};
          const triggered = [];
          for (const id of CAPACITY_ORDER) {
            const probability = hazardFast(id, date, last[id], statCache[id]);
            probabilities[id] = probability;
            if (random() < probability) triggered.push(id);
          }
          active = resolveConflicts(triggered, probabilities, random);
        }

        for (const id of active) {
          if (!firstSeen.has(id)) {
            firstSeen.add(id);
            counts[id].set(date, (counts[id].get(date) || 0) + 1);
            hitTotals[id] += 1;
          }
          last[id] = date;
        }

        if (firstSeen.size === CAPACITY_ORDER.length) break;
      }
    }

    return Object.fromEntries(CAPACITY_ORDER.map(id => {
      let bestDate = null;
      let bestCount = 0;
      for (const [date, count] of counts[id]) {
        if (count > bestCount || (count === bestCount && (!bestDate || date < bestDate))) {
          bestDate = date;
          bestCount = count;
        }
      }

      const last = initialLast[id];
      return [id, {
        date: bestDate,
        probability: bestCount / runs,
        coverage: hitTotals[id] / runs,
        gap: bestDate && last ? diffDays(last, bestDate) : null,
        horizon: dateList.length ? diffDays(startDate, dateList.at(-1)) : 0
      }];
    }));
  }

  function simulateNextHitForecast(startDate, days = NEXT_DATE_HORIZON) {
    const mainDays = Math.min(days, MAIN_NEXT_DATE_HORIZON);
    const firstDate = addDays(startDate, 1);
    const mainDates = Array.from({ length: mainDays }, (_, index) => addDays(firstDate, index));
    const mainActiveOrder = ORDER.filter(id => EVENTS[id].family !== 'capacity');
    const mainResults = simulateFirstHitPool(startDate, mainDates, mainActiveOrder, mainActiveOrder, 'next-main');

    const capacityWeeks = Math.max(1, Math.ceil(days / 7));
    const capacityDates = capacitySundayDates(startDate, capacityWeeks)
      .filter(date => diffDays(startDate, date) <= days);
    const capacityResults = simulateCapacityFirstHitForecast(startDate, capacityDates);

    return { ...mainResults, ...capacityResults };
  }

  function getNextHitForecast(startDate) {
    const key = simulationFingerprint(startDate);
    if (key !== nextHitCacheKey) {
      nextHitCacheKey = key;
      nextHitCacheValue = simulateNextHitForecast(startDate);
    }
    return nextHitCacheValue;
  }

  function simulateForecast(startDate, days = 7) {
    const cacheKey = `${simulationFingerprint(startDate)}|days:${days}`;
    if (forecastCache.has(cacheKey)) return forecastCache.get(cacheKey);

    const firstDate = addDays(startDate, 1);
    const dateList = Array.from({ length: days }, (_, index) => addDays(firstDate, index));
    const counts = Object.fromEntries(
      dateList.map(date => [date, Object.fromEntries(MODEL_ORDER.map(id => [id, 0]))])
    );
    const confirmed = store.getConfirmedDays();
    const baseSeed = forecastSeed(startDate);

    const statCache = {};
    const initialLast = {};
    MODEL_ORDER.forEach(id => {
      statCache[id] = buildStatCache(id, firstDate);
      initialLast[id] = store.lastEventBefore(id, firstDate) || store.modelDates(id).filter(date => date < firstDate).at(-1) || null;
    });

    for (let run = 0; run < SIM_RUNS; run += 1) {
      const random = simulationRunRandom(baseSeed, run);
      const last = { ...initialLast };

      for (const date of dateList) {
        if (isAnniversaryDate(date)) continue;

        if (confirmed[date]) {
          for (const id of confirmed[date]) {
            counts[date][id] += 1;
            last[id] = date;
          }
          continue;
        }

        const active = sampleActiveEvents(date, MODEL_ORDER, last, statCache, random).active;
        for (const id of active) {
          counts[date][id] += 1;
          last[id] = date;
        }
      }
    }

    const probabilities = {};
    for (const date of dateList) {
      probabilities[date] = {};
      MODEL_ORDER.forEach(id => {
        probabilities[date][id] = counts[date][id] / SIM_RUNS;
      });
    }
    forecastCache.set(cacheKey, probabilities);
    if (forecastCache.size > 8) forecastCache.delete(forecastCache.keys().next().value);
    return probabilities;
  }


  function capacitySundayDates(startDate, weeks = 4) {
    const count = clamp(Math.round(Number(weeks) || 4), 1, 52);
    const startDay = parseDate(startDate).getDay();
    const firstOffset = startDay === 0 ? 7 : 7 - startDay;
    const firstSunday = addDays(startDate, firstOffset);
    return Array.from({ length: count }, (_, index) => addDays(firstSunday, index * 7));
  }

  function capacityForecastSeed(startDate) {
    const state = store.getState();
    return hashString(`capacity|${startDate}|${JSON.stringify(state.settings)}|${JSON.stringify(state.overrides)}|${state.remote?.syncedAt || 'seed'}`);
  }

  function simulateCapacityForecast(startDate, weeks = 4) {
    const cacheKey = `${simulationFingerprint(startDate)}|capacity-weeks:${weeks}`;
    if (capacityForecastCache.has(cacheKey)) return capacityForecastCache.get(cacheKey);

    const dateList = capacitySundayDates(startDate, weeks);
    const counts = Object.fromEntries(
      dateList.map(date => [date, Object.fromEntries(CAPACITY_ORDER.map(id => [id, 0]))])
    );
    const confirmed = store.getConfirmedDays();
    const baseSeed = capacityForecastSeed(startDate);

    const statCache = {};
    const initialLast = {};
    const firstDate = addDays(startDate, 1);
    CAPACITY_ORDER.forEach(id => {
      statCache[id] = buildStatCache(id, firstDate);
      initialLast[id] = store.lastEventBefore(id, firstDate) || store.modelDates(id).filter(date => date < firstDate).at(-1) || null;
    });

    for (let run = 0; run < SIM_RUNS; run += 1) {
      const random = simulationRunRandom(baseSeed, run);
      const last = { ...initialLast };

      for (const date of dateList) {
        if (isAnniversaryDate(date)) continue;

        if (confirmed[date]) {
          for (const id of confirmed[date]) {
            if (!CAPACITY_ORDER.includes(id)) continue;
            counts[date][id] += 1;
            last[id] = date;
          }
          continue;
        }

        const probabilities = {};
        const triggered = [];
        for (const id of CAPACITY_ORDER) {
          const probability = hazardFast(id, date, last[id], statCache[id]);
          probabilities[id] = probability;
          if (random() < probability) triggered.push(id);
        }

        const active = resolveConflicts(triggered, probabilities, random);
        for (const id of active) {
          counts[date][id] += 1;
          last[id] = date;
        }
      }
    }

    const result = Object.fromEntries(dateList.map(date => [
      date,
      Object.fromEntries(CAPACITY_ORDER.map(id => [id, counts[date][id] / SIM_RUNS]))
    ]));
    capacityForecastCache.set(cacheKey, result);
    if (capacityForecastCache.size > 8) capacityForecastCache.delete(capacityForecastCache.keys().next().value);
    return result;
  }

  root.EggEventLab.model = {
    allowedWeekday,
    fixedNonUltraEvent,
    highestProbability,
    latestUltraCadenceDate,
    isUltraCadenceDate,
    latestEligibleGap,
    hazard,
    hazardFast,
    conflicts,
    nonUltraCandidatesForDate,
    ultraCandidatesForDate,
    buildStatCache,
    simulateCapacityFirstHitForecast,
    simulateNextHitForecast,
    getNextHitForecast,
    simulateForecast,
    capacitySundayDates,
    simulateCapacityForecast,
    invalidateNextHitCache
  };
})(typeof window !== 'undefined' ? window : globalThis);
