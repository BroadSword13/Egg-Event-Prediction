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
  function createModel(store = root.EggEventLab.store, scoped = false) {

  const FIXED_NON_ULTRA = {
    1: { label: 'Cash Boost', short: 'Cash Boost', icon: '💰', color: 'gold', family: 'earnings' },
    5: { label: 'Research Sale', short: 'Research Sale', icon: '🔬', color: 'teal', family: 'research' },
    6: { label: 'Prestige Boost', short: 'Prestige Boost', icon: '⭐', color: 'purple', family: 'prestige', note: 'Usually 2×; special multipliers can occur.' }
  };

  // Hot-path caches. Forecast simulations evaluate the same event/date pairs
  // thousands of times, so eligibility checks should be computed
  // once per model state rather than once per simulation run.
  const ultraCadenceCache = new Map();
  const allowedWeekdayCache = new Map();


  function fixedNonUltraEvent(dateStr) {
    if (isAnniversaryDate(dateStr)) return null;
    const dayOfWeek = parseDate(dateStr).getDay();
    if (dayOfWeek !== 0) return FIXED_NON_ULTRA[dayOfWeek] ? { ...FIXED_NON_ULTRA[dayOfWeek] } : null;

    const weekOffset = Math.round(diffDays(SUNDAY_ROTATION_ANCHOR, dateStr) / 7);
    const isCrafting = ((weekOffset % 2) + 2) % 2 === 0;
    return isCrafting
      ? { label: 'Crafting Sale', short: 'Crafting Sale', icon: '🛠️', color: 'amber', family: 'crafting' }
      : { label: 'Epic Research Sale', short: 'Epic Research Sale', icon: '📚', color: 'gold', family: 'epic-research' };
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

  // Non-Ultra estimates include a weak prior so missing or unseen gaps are
  // uncertain rather than impossible. One recent observation has weight 3.
  const NON_ULTRA_PRIOR_WEIGHT = 3;
  const NON_ULTRA_HAZARD_CEILING = 0.95;

  function softGapProfile(eventId, rows) {
    const event = EVENTS[eventId];
    const support = rows.reduce((sum, row) => sum + row.weighted, 0);
    const meanGap = support > 0
      ? rows.reduce((sum, row) => sum + row.gap * row.weighted, 0) / support
      : event.sundayOnly ? 28 : 14;
    const eligibleFraction = event.sundayOnly ? 1 / 7
      : event.weekdayObserved && store.getState().settings.weekdayPattern ? 3 / 7 : 1;
    const prior = 1 / Math.max(2, meanGap * eligibleFraction);
    const maximum = rows.length ? Math.max(...rows.map(row => row.gap)) : 0;
    const tailMass = rows.find(row => row.gap === maximum)?.weighted || 0;
    const tailBase = (tailMass + NON_ULTRA_PRIOR_WEIGHT * prior) / (tailMass + NON_ULTRA_PRIOR_WEIGHT);
    return { meanGap, prior, maximum, tailBase };
  }

  function nonUltraHazard(eventId, gap, stats) {
    const profile = stats.soft || softGapProfile(eventId, stats.rows);
    if (gap == null) return profile.prior;
    const exact = stats.exact.get(gap) || 0;
    const survivor = stats.survivor.get(gap) || 0;
    let probability = (exact + NON_ULTRA_PRIOR_WEIGHT * profile.prior)
      / (survivor + NON_ULTRA_PRIOR_WEIGHT);
    if (gap > profile.maximum) {
      // Extend the final observed hazard smoothly; never drop to zero after
      // passing the longest observed gap. With no gaps, start from the prior.
      probability = 1 - (1 - profile.tailBase)
        * Math.exp(-(gap - profile.maximum) / profile.meanGap);
    }
    return clamp(probability, 0, NON_ULTRA_HAZARD_CEILING);
  }

  function hazard(eventId, targetDate, simulatedHistory = null) {
    const last = store.lastEventBefore(eventId, targetDate, simulatedHistory);
    return hazardFast(eventId, targetDate, last, buildStatCache(eventId, targetDate));
  }

  function hazardFast(eventId, targetDate, lastDate, stats) {
    const event = EVENTS[eventId];
    if (!allowedWeekday(eventId, targetDate)) return 0;
    const gap = lastDate ? diffDays(lastDate, targetDate) : null;
    if (gap != null && event.minGap && gap < event.minGap) return 0;
    if (event.tier === 'non-ultra') return nonUltraHazard(eventId, gap, stats);
    if (!lastDate) return 0;
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

    return { rows, exact, survivor, soft: EVENTS[eventId].tier === 'non-ultra' ? softGapProfile(eventId, rows) : null };
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

  function isHardBlocked(eventId, targetDate, lastDate) {
    const event = EVENTS[eventId];
    const state = store.getState();
    if (!allowedWeekday(eventId, targetDate)) return true;

    // Missing history means the model does not know the rotation's current gap;
    // it is not evidence that the event is impossible. This matters for the
    // bundled fallback data, which intentionally does not contain every event.
    if (!lastDate) return false;

    const gap = diffDays(lastDate, targetDate);
    if (event.minGap && gap < event.minGap) return true;

    return false;
  }

  function fallbackPoolWeights(ids, statCache = null, hardBlocked = null) {
    const supports = Object.fromEntries(ids.map(id => {
      if (hardBlocked?.[id]) return [id, 0];
      const rows = statCache?.[id]?.rows || store.gapStats(id);
      return [id, rows.reduce((sum, row) => sum + row.weighted, 0)];
    }));

    const known = Object.values(supports).filter(value => value > 0).sort((a, b) => a - b);
    const middle = Math.floor(known.length / 2);
    const neutralPrior = known.length === 0
      ? 1
      : known.length % 2
        ? known[middle]
        : (known[middle - 1] + known[middle]) / 2;

    return Object.fromEntries(ids.map(id => {
      if (hardBlocked?.[id]) return [id, 0];
      return [id, supports[id] > 0 ? supports[id] : neutralPrior];
    }));
  }

  function directPoolWeights(ids, probabilities, hardBlocked = null) {
    return Object.fromEntries(ids.map(id => [
      id,
      hardBlocked?.[id] ? 0 : Math.max(Number(probabilities[id] || 0), 0)
    ]));
  }

  function poolWeights(ids, probabilities, statCache = null, hardBlocked = null) {
    const direct = directPoolWeights(ids, probabilities, hardBlocked);
    const total = Object.values(direct).reduce((sum, value) => sum + value, 0);
    return total > 0 ? direct : fallbackPoolWeights(ids, statCache, hardBlocked);
  }

  function weightedChoice(ids, weights, random, statCache = null, hardBlocked = null) {
    if (!ids.length) return null;
    const weightMap = poolWeights(ids, weights, statCache, hardBlocked);
    const sanitized = ids.map(id => weightMap[id] || 0);
    const total = sanitized.reduce((sum, value) => sum + value, 0);

    // A guaranteed slot must still choose an event when learned hazards are all
    // zero, but hard-rule zeros remain impossible. Rotations with missing
    // fallback history receive a neutral prior instead of being treated as
    // impossible or allowing one known rotation to become artificially certain.
    if (total <= 0) return null;

    let roll = random() * total;
    for (let index = 0; index < ids.length; index += 1) {
      roll -= sanitized[index];
      if (roll <= 0) return ids[index];
    }
    return ids.findLast(id => !hardBlocked?.[id]) || null;
  }

  function weightedCompatiblePair(nonUltraIds, ultraIds, probabilities, statCache, random, hardBlocked = null) {
    function buildPairs(nonUltraWeights, ultraWeights) {
      const pairs = [];
      let total = 0;
      for (const nonUltra of nonUltraIds) {
        for (const ultra of ultraIds) {
          if (conflicts(nonUltra, ultra)) continue;
          const weight = (nonUltraWeights[nonUltra] || 0) * (ultraWeights[ultra] || 0);
          pairs.push({ nonUltra, ultra, weight });
          total += weight;
        }
      }
      return { pairs, total };
    }

    let nonUltraWeights = poolWeights(nonUltraIds, probabilities, statCache, hardBlocked);
    let ultraWeights = poolWeights(ultraIds, probabilities, statCache, hardBlocked);
    let { pairs, total } = buildPairs(nonUltraWeights, ultraWeights);

    // Direct hazards can occasionally leave only mutually conflicting choices.
    // In that case, expand to the same safe fallback priors used by a single
    // guaranteed slot, while continuing to exclude hard-blocked rotations.
    if (total <= 0) {
      nonUltraWeights = fallbackPoolWeights(nonUltraIds, statCache, hardBlocked);
      ultraWeights = fallbackPoolWeights(ultraIds, statCache, hardBlocked);
      ({ pairs, total } = buildPairs(nonUltraWeights, ultraWeights));
    }

    if (!pairs.length || total <= 0) return { nonUltra: null, ultra: null };
    let roll = random() * total;
    for (const pair of pairs) {
      roll -= pair.weight;
      if (roll <= 0) return pair;
    }
    return pairs.at(-1);
  }

  function sampleActiveEvents(date, activeOrder, last, statCache, random) {
    const probabilities = {};
    const hardBlocked = {};
    const triggered = [];
    const nonUltraCandidates = nonUltraCandidatesForDate(date, activeOrder);
    const ultraCandidates = ultraCandidatesForDate(date, activeOrder);
    const guaranteedSet = new Set([...nonUltraCandidates, ...ultraCandidates]);

    for (const id of activeOrder) {
      hardBlocked[id] = isHardBlocked(id, date, last[id]);
      const probability = hazardFast(id, date, last[id], statCache[id]);
      probabilities[id] = probability;
      if (guaranteedSet.has(id)) continue;
      if (random() < probability) triggered.push(id);
    }

    let guaranteedNonUltra = null;
    let guaranteedUltra = null;

    // Elapsed time affects weights, never forces a particular Non-Ultra event.
    const selectableNonUltra = nonUltraCandidates;
    const selectableUltra = ultraCandidates;

    if (selectableNonUltra.length && selectableUltra.length) {
      const pair = weightedCompatiblePair(selectableNonUltra, selectableUltra, probabilities, statCache, random, hardBlocked);
      guaranteedNonUltra = pair.nonUltra;
      guaranteedUltra = pair.ultra;
    } else if (selectableNonUltra.length) {
      guaranteedNonUltra = weightedChoice(selectableNonUltra, probabilities, random, statCache, hardBlocked);
    } else if (selectableUltra.length) {
      guaranteedUltra = weightedChoice(selectableUltra, probabilities, random, statCache, hardBlocked);
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
    forecastCache.clear();
    capacityForecastCache.clear();
  }

  function simulationFingerprint(startDate) {
    // Only effective history through the reference day influences the seed.
    // Sync timestamps, later confirmations, and future corrections cannot repaint it.
    const historical = root.EggEventLab.store.createStore(store.clone(store.getState()), startDate);
    return JSON.stringify([startDate, historical.getState().settings,
      MODEL_ORDER.map(id => historical.modelDates(id))]);
  }

  function forecastSeed(startDate) {
    return hashString(simulationFingerprint(startDate));
  }

  function simulationRunRandom(baseSeed, run) {
    return mulberry32(hashString(`${baseSeed}|run:${run}`));
  }

  function* simulateFirstHitPoolSteps(startDate, dateList, activeOrder, targetOrder, seedLabel, runs = NEXT_HIT_RUNS) {
    const firstDate = addDays(startDate, 1);
    const confirmed = store.getConfirmedDays();
    const counts = Object.fromEntries(targetOrder.map(id => [id, new Map()]));
    const hitTotals = Object.fromEntries(targetOrder.map(id => [id, 0]));
    const state = store.getState();
    const baseSeed = hashString(`${seedLabel}|${simulationFingerprint(startDate)}`);

    const statCache = {};
    const initialLast = {};
    activeOrder.forEach(id => {
      statCache[id] = buildStatCache(id, firstDate);
      initialLast[id] = store.lastEventBefore(id, firstDate) || store.modelDates(id).filter(date => date < firstDate).at(-1) || null;
    });

    for (let run = 0; run < runs; run += 1) {
      if (run % 8 === 0) yield;
      const random = simulationRunRandom(baseSeed, run);
      const last = { ...initialLast };
      const firstSeen = new Set();

      for (const date of dateList) {
        if (date.endsWith('-01')) yield;
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

  function* simulateCapacityFirstHitForecastSteps(startDate, dateList, runs = NEXT_HIT_RUNS) {
    const firstDate = addDays(startDate, 1);
    const confirmed = store.getConfirmedDays();
    const counts = Object.fromEntries(CAPACITY_ORDER.map(id => [id, new Map()]));
    const hitTotals = Object.fromEntries(CAPACITY_ORDER.map(id => [id, 0]));
    const state = store.getState();
    const baseSeed = hashString(`next-capacity|${simulationFingerprint(startDate)}`);

    const statCache = {};
    const initialLast = {};
    CAPACITY_ORDER.forEach(id => {
      statCache[id] = buildStatCache(id, firstDate);
      initialLast[id] = store.lastEventBefore(id, firstDate) || store.modelDates(id).filter(date => date < firstDate).at(-1) || null;
    });

    for (let run = 0; run < runs; run += 1) {
      if (run % 8 === 0) yield;
      const random = simulationRunRandom(baseSeed, run);
      const last = { ...initialLast };
      const firstSeen = new Set();

      for (const date of dateList) {
        if (date.endsWith('-01')) yield;
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

  function* simulateNextHitForecastSteps(startDate, days = NEXT_DATE_HORIZON) {
    const mainDays = Math.min(days, MAIN_NEXT_DATE_HORIZON);
    const firstDate = addDays(startDate, 1);
    const mainDates = Array.from({ length: mainDays }, (_, index) => addDays(firstDate, index));
    const mainActiveOrder = ORDER.filter(id => EVENTS[id].family !== 'capacity');
    const mainResults = yield* simulateFirstHitPoolSteps(startDate, mainDates, mainActiveOrder, mainActiveOrder, 'next-main');

    const capacityWeeks = Math.max(1, Math.ceil(days / 7));
    const capacityDates = capacitySundayDates(startDate, capacityWeeks)
      .filter(date => diffDays(startDate, date) <= days);
    const capacityResults = yield* simulateCapacityFirstHitForecastSteps(startDate, capacityDates);

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

  function* simulateForecastSteps(startDate, days = 7) {
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
      if (run % 8 === 0) yield;
      const random = simulationRunRandom(baseSeed, run);
      const last = { ...initialLast };

      for (const date of dateList) {
        if (date.endsWith('-01')) yield;
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


  function calendarPredictionPicks(dateStr, probabilities = {}, threshold = 0.25, options = {}) {
    const minimum = clamp(Number(threshold) || 0, 0, 1);
    const showNonUltra = options.showNonUltra !== false;
    const showUltra = options.showUltra !== false;
    const picks = [];

    if (showNonUltra) {
      const fixed = fixedNonUltraEvent(dateStr);
      if (fixed) {
        picks.push({
          id: null,
          tier: 'non-ultra',
          probability: 1,
          fixed: true,
          ...fixed
        });
      } else {
        const best = highestProbability(probabilities, [...NON_ULTRA_MIDWEEK_POOL]);
        if (best && best.probability > 0 && best.probability >= minimum) {
          picks.push({ id: best.id, tier: 'non-ultra', probability: best.probability, fixed: false, ...EVENTS[best.id] });
        }
      }

      const capacityProbability = Number(probabilities.capacity_purple || 0);
      if (parseDate(dateStr).getDay() === 0 && capacityProbability > 0 && capacityProbability >= minimum) {
        picks.push({ id: 'capacity_purple', tier: 'non-ultra', probability: capacityProbability, fixed: false, ...EVENTS.capacity_purple });
      }
    }

    if (showUltra) {
      const best = highestProbability(probabilities, [...ULTRA_CADENCE_POOL]);
      if (best && best.probability > 0 && best.probability >= minimum) {
        picks.push({ id: best.id, tier: 'ultra', probability: best.probability, fixed: false, ...EVENTS[best.id] });
      }
    }

    return picks;
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
    return hashString(`capacity|${simulationFingerprint(startDate)}`);
  }

  function* simulateCapacityForecastSteps(startDate, weeks = 4) {
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
      if (run % 8 === 0) yield;
      const random = simulationRunRandom(baseSeed, run);
      const last = { ...initialLast };

      for (const date of dateList) {
        if (date.endsWith('-01')) yield;
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

  const steps = { simulateForecast: simulateForecastSteps,
    simulateCapacityForecast: simulateCapacityForecastSteps,
    simulateNextHitForecast: simulateNextHitForecastSteps,
    simulateCapacityFirstHitForecast: simulateCapacityFirstHitForecastSteps };

  function forecastSteps(method, args) {
    if (!steps[method]) throw new Error('Unknown forecast method');
    if (scoped) return steps[method](...args);
    const snapshot = root.EggEventLab.store.createStore(store.clone(store.getState()), args[0]);
    return createModel(snapshot, true).forecastSteps(method, args);
  }

  function finish(method, args) {
    const iterator = forecastSteps(method, args);
    let result;
    do { result = iterator.next(); } while (!result.done);
    return result.value;
  }
  function simulateForecast(...args) { return finish('simulateForecast', args); }
  function simulateCapacityForecast(...args) { return finish('simulateCapacityForecast', args); }
  function simulateNextHitForecast(...args) { return finish('simulateNextHitForecast', args); }
  function simulateCapacityFirstHitForecast(...args) { return finish('simulateCapacityFirstHitForecast', args); }

  return {
    createModel,
    forecastSteps,

    allowedWeekday,
    fixedNonUltraEvent,
    highestProbability,
    latestUltraCadenceDate,
    isUltraCadenceDate,
    hazard,
    hazardFast,
    isHardBlocked,
    conflicts,
    nonUltraCandidatesForDate,
    ultraCandidatesForDate,
    buildStatCache,
    simulateCapacityFirstHitForecast,
    simulateNextHitForecast,
    getNextHitForecast,
    simulateForecast,
    calendarPredictionPicks,
    capacitySundayDates,
    simulateCapacityForecast,
    invalidateNextHitCache
  };
  }
  root.EggEventLab.model = createModel();
})(typeof window !== 'undefined' ? window : globalThis);
