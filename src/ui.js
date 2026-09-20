(function (root) {
  'use strict';

  const {
    APP_VERSION,
    EXPORT_SCHEMA_VERSION,
    TODAY_SEED,
    REMOTE_DATA_START,
    REMOTE_SCHEMA_VERSION,
    EVENTS,
    ORDER,
    MAIN_ORDER,
    CORE_DAILY_ORDER,
    CAPACITY_ORDER,
    MODEL_ORDER,
    NON_ULTRA_MIDWEEK_POOL,
    ULTRA_MIDWEEK_POOL,
    DEFAULT_SETTINGS,
    DEFAULT_UI,
    DEFAULT_REMOTE,
    NEXT_DATE_HORIZON,
    SIM_RUNS,
    NEXT_HIT_RUNS,
    MODEL_TIME_ZONE,
    EVENT_START_HOUR
  } = root.EggEventLab.config;
  const {
    parseDate,
    isoDate,
    addDays,
    diffDays,
    fmtDate,
    weekdayShort,
    clamp,
    pct,
    escapeHtml,
    browserTimeZone,
    eventDisplayDateIso,
    fmtEventDate,
    eventWeekdayShort,
    modelDateForDisplayDate,
    advanceForecastReference,
    forecastDisplayDates
  } = root.EggEventLab.utils;
  const store = root.EggEventLab.store;
  const model = root.EggEventLab.model;
  const wasmegg = root.EggEventLab.wasmegg;
  const clock = root.EggEventLab.clock;
  const forecasts = root.EggEventLab.forecasts;
  let followCurrentDay = true;

  let currentTab = 'forecast';
  let calendarCursor = new Date(2026, 8, 1);
  let tooltip = null;
  let observedEventDate = null;
  let eventDayWatcher = null;
  let rolloverSyncInFlight = false;
  const DATA_PAGE_SIZE = 100;
  const CALENDAR_PREDICTION_HORIZON = 90;
  let dataVisibleRows = DATA_PAGE_SIZE;
  let dataRowsCacheKey = null;
  let dataRowsCache = [];

  function state() {
    return store.getState();
  }

  function invalidateDataRows() {
    dataRowsCacheKey = null;
    dataRowsCache = [];
  }

  function advanceForecastToCurrentEventDay() {
    const input = document.getElementById('forecastStart');
    if (!input || !followCurrentDay) return false;
    const currentEventDate = clock.currentEventDate();
    const nextReference = currentEventDate;
    if (nextReference === input.value) return false;
    input.value = nextReference;
    model.invalidateNextHitCache();
    return true;
  }

  function startEventDayWatcher() {
    if (eventDayWatcher) clearInterval(eventDayWatcher);
    observedEventDate = clock.currentEventDate();
    eventDayWatcher = setInterval(async () => {
      const currentEventDate = clock.currentEventDate();
      if (currentEventDate === observedEventDate) return;

      observedEventDate = currentEventDate;
      advanceForecastToCurrentEventDay();
      renderAll();

      if (state().remote?.autoSync === false || rolloverSyncInFlight) return;
      rolloverSyncInFlight = true;
      try {
        await syncWasmegg({ silent: true });
      } finally {
        rolloverSyncInFlight = false;
      }
    }, 60000);
  }


  function eventDateView(value, options = { month: 'short', day: 'numeric', year: 'numeric' }) {
    const localIso = eventDisplayDateIso(value);
    return {
      text: fmtEventDate(value, options),
      weekday: eventWeekdayShort(value),
      localIso,
      shifted: localIso !== value,
      canonical: value
    };
  }

  function canonicalNote(value) {
    const view = eventDateView(value, { month: 'short', day: 'numeric' });
    return view.shifted ? `${fmtDate(value, { month: 'short', day: 'numeric' })} Pacific event date` : '';
  }

  function renderClockStatus() {
    const info = clock.status();
    const localZone = browserTimeZone();
    const badge = document.getElementById('clockBadge');
    if (badge) {
      badge.textContent = info.source === 'server' ? 'Clock: server · Pacific' : 'Clock: browser fallback';
      badge.classList.toggle('sync-good', info.source === 'server');
      badge.classList.toggle('sync-error', info.source !== 'server');
      badge.title = info.source === 'server'
        ? 'Current time is synchronized from the hosting server and interpreted in America/Los_Angeles.'
        : 'No HTTP server clock was available, so the browser clock is being used.';
    }

    const hint = document.getElementById('forecastTimeZoneHint');
    if (hint) {
      hint.textContent = `Picker: Pacific event date · 9:00 AM Pacific rollover · Results shown in ${localZone}${localZone === MODEL_TIME_ZONE ? ' (same as model)' : ''}.`;
    }
    const details = document.getElementById('timeZoneDetails');
    if (details) {
      details.innerHTML = `Time source: <strong>${info.source === 'server' ? 'hosting server' : 'browser fallback'}</strong> · Model zone: <strong>${MODEL_TIME_ZONE}</strong> · Daily rollover: <strong>${EVENT_START_HOUR}:00 Pacific</strong> · Display zone: <strong>${escapeHtml(localZone)}</strong>`;
    }
  }

  function probabilityClass(probability) {
    if (probability >= 0.6) return 'hot';
    if (probability >= 0.3) return 'high';
    if (probability >= 0.12) return 'mid';
    return 'low';
  }

  function familyLabel(event) {
    const labels = {
      housing: 'Hab Sale',
      shipping: 'Vehicle Sale',
      drone: 'Generous Drones',
      capacity: 'Mission Capacity Boost',
      'boost-duration': 'Boost Time+',
      gifts: 'Generous Gifts',
      shells: 'Shell Sale',
      fueling: 'Mission Fuel Boost'
    };
    return labels[event.family] || event.family;
  }

  function toast(message) {
    const element = document.getElementById('toast');
    element.textContent = message;
    element.classList.add('show');
    setTimeout(() => element.classList.remove('show'), 2200);
  }

  function showTip(element) {
    tooltip.textContent = element.dataset.tip.replaceAll('&#10;', '\n');
    tooltip.style.whiteSpace = 'pre-line';
    tooltip.style.display = 'block';
    const bounds = element.getBoundingClientRect();
    tooltip.style.left = `${Math.min(window.innerWidth - 280, bounds.left)}px`;
    tooltip.style.top = `${Math.max(8, bounds.bottom + 8)}px`;
  }

  function moveTip(event) {
    if (window.innerWidth < 700) return;
    tooltip.style.left = `${Math.min(window.innerWidth - 280, event.clientX + 12)}px`;
    tooltip.style.top = `${Math.min(window.innerHeight - 170, event.clientY + 12)}px`;
  }

  function hideTip() {
    if (tooltip) tooltip.style.display = 'none';
  }

  function bindTips() {
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'tooltip';
      document.body.appendChild(tooltip);
    }

    document.querySelectorAll('[data-tip]').forEach(element => {
      if (element.dataset.tipBound === '1') return;
      element.dataset.tipBound = '1';
      element.addEventListener('mouseenter', event => showTip(event.currentTarget));
      element.addEventListener('mousemove', moveTip);
      element.addEventListener('mouseleave', hideTip);
      element.addEventListener('click', event => {
        showTip(event.currentTarget);
        setTimeout(hideTip, 2600);
      });
    });
  }

  function renderWasmeggSyncStatus(mode = null) {
    const current = state();
    const badge = document.getElementById('wasmeggSyncBadge');
    const details = document.getElementById('wasmeggSyncDetails');
    const buttons = [
      document.getElementById('syncWasmeggBtn'),
      document.getElementById('syncWasmeggDataBtn')
    ].filter(Boolean);

    buttons.forEach(button => {
      button.disabled = mode === 'busy';
    });
    if (!badge) return;

    badge.classList.remove('sync-good', 'sync-busy', 'sync-error');
    if (mode === 'busy') {
      badge.textContent = 'Wasmegg: syncing…';
      badge.classList.add('sync-busy');
    } else if (current.remote?.lastError) {
      badge.textContent = store.hasRemoteData() ? 'Wasmegg: cached' : 'Wasmegg: sync failed';
      badge.classList.add('sync-error');
    } else if (store.hasRemoteData()) {
      badge.textContent = `Wasmegg: through ${fmtEventDate(current.remote.latestDate, { month: 'short', day: 'numeric' })}`;
      badge.classList.add('sync-good');
    } else {
      badge.textContent = 'Wasmegg: seed data';
    }

    if (details) {
      const synced = current.remote?.syncedAt ? new Date(current.remote.syncedAt).toLocaleString() : 'Never';
      const through = current.remote?.latestDate
        ? fmtEventDate(current.remote.latestDate, { month: 'short', day: 'numeric', year: 'numeric' })
        : 'Built-in seed';
      const error = current.remote?.lastError
        ? `<br><span class="sync-error-text">Last error: ${escapeHtml(current.remote.lastError)}</span>`
        : '';
      details.innerHTML = `Source: Wasmegg Events Calendar dataset<br>Imported range: <strong>${fmtDate(REMOTE_DATA_START, { month: 'short', day: 'numeric', year: 'numeric' })} → ${through}</strong><br>Daily rotations: Hab Sale · Vehicle Sale · Generous Drones · Boost Time+ · Generous Gifts · Shell Sale · Mission Fuel Boost<br>Egg Day exclusion: <strong>July 14 ignored by the probability model</strong><br>Last successful sync: <strong>${synced}</strong>${error}`;
    }
    renderClockStatus();
  }

  async function syncWasmegg({ silent = false } = {}) {
    const previousLatest = store.latestConfirmedDay();
    renderWasmeggSyncStatus('busy');
    await clock.sync();
    renderClockStatus();
    observedEventDate = clock.currentEventDate();
    const referenceAdvanced = advanceForecastToCurrentEventDay();
    const result = await wasmegg.sync();

    if (result.ok) {
      model.invalidateNextHitCache();
      invalidateDataRows();
      const newLatest = store.latestConfirmedDay();
      const record = document.getElementById('recordDate');
      if (record && (!record.value || record.value === previousLatest)) loadRecordDate(newLatest);
      renderAll();
      renderWasmeggSyncStatus();
      if (!silent) toast(`Wasmegg synced through ${fmtEventDate(state().remote.latestDate, { month: 'short', day: 'numeric' })}`);
      return true;
    }

    if (referenceAdvanced) renderAll();
    renderWasmeggSyncStatus();
    if (!silent) toast('Wasmegg sync failed; using cached/seed data');
    return false;
  }

  function forecastDetail(eventId, date, probability, history, historicalModel, reference) {
    const last = history.lastEventBefore(eventId, date);
    const gap = last ? diffDays(last, date) : null;
    const stats = historicalModel.buildStatCache(eventId, addDays(reference, 1));
    const hazard = historicalModel.hazardFast(eventId, date, last, stats);
    const rows = stats.rows;
    const stat = rows.find(row => row.gap === gap);
    const count = stat?.count || 0;
    const survivor = rows.filter(row => row.gap >= gap).reduce((sum, row) => sum + row.count, 0);
    const event = EVENTS[eventId];
    const current = state();
    const bits = [event.label, `Forecast: ${pct(probability)}`];

    if (gap != null) {
      bits.push(
        `Gap if there is no earlier hit: ${gap} days`,
        `Raw historical count at gap: ${count}`,
        `${event.tier === 'non-ultra' ? 'Smoothed' : 'Raw'} hazard if there is no earlier hit: ${pct(hazard)}`,
        'Final probabilities also account for simulated earlier hits and competing events.'
      );
    }
    if (survivor) bits.push(`Historical gaps surviving this long: ${survivor}`);
    if (event.tier === 'non-ultra') bits.push('Soft gap estimate: unseen gaps retain a chance; overdue events are favored without a forced deadline.');
    if (current.settings.weekdayPattern && event.weekdayObserved) bits.push('Observed weekday pattern: Tue–Thu');
    if (NON_ULTRA_MIDWEEK_POOL.has(eventId)) {
      bits.push('Shares the Non-Ultra Tue–Thu event pool (Hab Sale, Vehicle Sale, Generous Drones, Boost Time+, Generous Gifts, Shell Sale, Mission Fuel Boost).');
    }
    if (ULTRA_MIDWEEK_POOL.has(eventId)) {
      bits.push('Shares the Ultra event pool (Hab Sale, Vehicle Sale, Generous Drones, Boost Time+, Generous Gifts, Shell Sale, Mission Fuel Boost).');
    }
    return bits.join('\n');
  }

  function selectedForecastIds() {
    const saved = Array.isArray(state().ui?.forecastEvents) ? state().ui.forecastEvents : DEFAULT_UI.forecastEvents;
    return MAIN_ORDER.filter(id => saved.includes(id));
  }

  function selectedCapacityIds() {
    const saved = Array.isArray(state().ui?.capacityEvents) ? state().ui.capacityEvents : CAPACITY_ORDER;
    return CAPACITY_ORDER.filter(id => saved.includes(id));
  }

  function setForecastSelection(ids) {
    const current = state();
    current.ui ||= store.clone(DEFAULT_UI);
    current.ui.forecastEvents = MAIN_ORDER.filter(id => ids.includes(id));
    if (!current.ui.forecastEvents.length) current.ui.forecastEvents = [...DEFAULT_UI.forecastEvents];
    store.saveState();
    renderForecastEventPicker();
    renderForecast();
  }

  function setCapacitySelection(ids) {
    const current = state();
    current.ui ||= store.clone(DEFAULT_UI);
    current.ui.capacityEvents = CAPACITY_ORDER.filter(id => ids.includes(id));
    if (!current.ui.capacityEvents.length) current.ui.capacityEvents = [...CAPACITY_ORDER];
    store.saveState();
    renderCapacityEventPicker();
    renderForecast();
  }

  function renderForecastEventPicker() {
    const box = document.getElementById('forecastEventPicker');
    const toggle = document.getElementById('eventPickerToggle');
    if (!box || !toggle) return;

    const selected = selectedForecastIds();
    toggle.textContent = selected.length === MAIN_ORDER.length ? `Events: All ${MAIN_ORDER.length}` : `Events: ${selected.length} selected`;
    const quick = [
      ['all', 'All'], ['housing', 'Hab Sale'], ['shipping', 'Vehicle Sale'], ['drone', 'Generous Drones'],
      ['boost-duration', 'Boost Time+'], ['gifts', 'Generous Gifts'], ['shells', 'Shell Sale'], ['fueling', 'Mission Fuel Boost'],
      ['non-ultra', 'Non-Ultra'], ['ultra', 'Ultra']
    ];

    box.innerHTML = `<div class="forecast-picker-top"><div><strong>Daily events</strong><div class="muted small">All modeled daily event rotations are available here. Mission Capacity Boost remains separate below because it only occurs on Sundays.</div></div><div class="forecast-quick-select">${quick.map(([key, label]) => `<button class="pill" type="button" data-quick-select="${key}">${label}</button>`).join('')}</div></div>` +
      `<div class="forecast-event-options">${MAIN_ORDER.map(id => {
        const event = EVENTS[id];
        return `<label class="forecast-event-option"><input type="checkbox" data-forecast-event="${id}" ${selected.includes(id) ? 'checked' : ''}/><span class="dot ${event.color}"></span><span>${event.label}</span></label>`;
      }).join('')}</div>`;

    box.querySelectorAll('[data-forecast-event]').forEach(input => input.addEventListener('change', () => {
      const ids = [...box.querySelectorAll('[data-forecast-event]:checked')].map(element => element.dataset.forecastEvent);
      if (!ids.length) {
        input.checked = true;
        toast('Keep at least one event selected');
        return;
      }
      state().ui.forecastEvents = MAIN_ORDER.filter(id => ids.includes(id));
      store.saveState();
      renderForecastEventPicker();
      renderForecast();
    }));

    box.querySelectorAll('[data-quick-select]').forEach(button => button.addEventListener('click', () => {
      const key = button.dataset.quickSelect;
      let ids;
      if (key === 'all') ids = [...MAIN_ORDER];
      else if (key === 'non-ultra' || key === 'ultra') ids = MAIN_ORDER.filter(id => EVENTS[id].tier === key);
      else ids = MAIN_ORDER.filter(id => EVENTS[id].family === key);
      setForecastSelection(ids);
    }));
  }

  function renderCapacityEventPicker() {
    const box = document.getElementById('capacityEventPicker');
    const toggle = document.getElementById('capacityPickerToggle');
    if (!box || !toggle) return;

    const selected = selectedCapacityIds();
    toggle.textContent = selected.length === CAPACITY_ORDER.length ? 'Mission Capacity Boost: Both' : `Mission Capacity Boost: ${EVENTS[selected[0]].tier === 'ultra' ? 'Ultra' : 'Non-Ultra'}`;
    box.innerHTML = `<div class="forecast-picker-top"><div><strong>Mission Capacity Boost events</strong><div class="muted small">Only Pacific-time Sundays are shown.</div></div><div class="forecast-quick-select"><button class="pill" type="button" data-capacity-quick="all">Both</button><button class="pill" type="button" data-capacity-quick="non-ultra">Non-Ultra</button><button class="pill" type="button" data-capacity-quick="ultra">Ultra</button></div></div>` +
      `<div class="forecast-event-options capacity-options">${CAPACITY_ORDER.map(id => {
        const event = EVENTS[id];
        return `<label class="forecast-event-option"><input type="checkbox" data-capacity-event="${id}" ${selected.includes(id) ? 'checked' : ''}/><span class="dot ${event.color}"></span><span>${event.label}</span></label>`;
      }).join('')}</div>`;

    box.querySelectorAll('[data-capacity-event]').forEach(input => input.addEventListener('change', () => {
      const ids = [...box.querySelectorAll('[data-capacity-event]:checked')].map(element => element.dataset.capacityEvent);
      if (!ids.length) {
        input.checked = true;
        toast('Keep at least one capacity event selected');
        return;
      }
      state().ui.capacityEvents = CAPACITY_ORDER.filter(id => ids.includes(id));
      store.saveState();
      renderCapacityEventPicker();
      renderForecast();
    }));

    box.querySelectorAll('[data-capacity-quick]').forEach(button => button.addEventListener('click', () => {
      const key = button.dataset.capacityQuick;
      const ids = key === 'all' ? [...CAPACITY_ORDER] : CAPACITY_ORDER.filter(id => EVENTS[id].tier === key);
      setCapacitySelection(ids);
    }));
  }

  function renderNextLikely(start, ids, targetId, next) {
    const box = document.getElementById(targetId);
    if (!box) return;

    box.innerHTML = ids.map(id => {
      const event = EVENTS[id];
      const row = next[id];
      if (!row?.date) {
        const horizon = row?.horizon || NEXT_DATE_HORIZON;
        return `<div class="likely-card"><div class="name"><span class="dot ${event.color}"></span>${event.short}</div><div class="next-date">No date</div><div class="next-day">within ${horizon} days</div><div class="meta">The current model did not produce a next hit in the look-ahead window.</div></div>`;
      }

      const coverageNote = row.coverage < 0.995 ? ` · ${(row.coverage * 100).toFixed(0)}% hit within window` : '';
      const view = eventDateView(row.date);
      const zoneNote = view.shifted ? `<div class="meta">${fmtDate(row.date, { month: 'short', day: 'numeric', year: 'numeric' })} Pacific event date</div>` : '';
      return `<div class="likely-card"><div class="name"><span class="dot ${event.color}"></span>${event.short}</div><div class="next-date">${view.text}</div><div class="next-day">${view.weekday} · ${row.gap ?? '—'}d gap</div>${zoneNote}<div class="confidence"><span class="prob ${probabilityClass(row.probability)}">${pct(row.probability)}</span><span class="meta">chance the next hit lands here</span></div><div class="meta">Based on ${NEXT_HIT_RUNS.toLocaleString()} first-hit simulations${coverageNote}</div></div>`;
    }).join('');
  }

  function rotationCard(id, start) {
    const event = EVENTS[id];
    const cutoff = addDays(start, 1);
    const last = store.lastEventOnOrBefore(id, start) || store.getAllEventDates(id).filter(date => date <= start).at(-1);
    const gap = last ? diffDays(last, start) : 0;
    const stats = store.gapStats(id, cutoff);
    const common = [...stats]
      .sort((a, b) => b.weighted - a.weighted)
      .slice(0, 3)
      .map(row => `${row.gap}d`)
      .join(' · ');
    const gapLabel = gap === 0 ? (start === clock.currentEventDate() ? 'Today' : 'Selected day') : `${gap}d`;
    return `<div class="rotation-card"><div class="name"><span class="dot ${event.color}"></span>${event.short}</div><div class="gap">${gapLabel}</div><div class="meta">Last: ${last ? fmtEventDate(last, { month: 'short', day: 'numeric' }) : '—'}</div><div class="meta">Common: ${common || '—'}</div></div>`;
  }

  function renderRotationCards(start) {
    const box = document.getElementById('rotationCards');
    box.innerHTML = MAIN_ORDER.map(id => rotationCard(id, start)).join('');
  }

  function renderCapacityRotationCards(start) {
    const box = document.getElementById('capacityRotationCards');
    if (!box) return;
    box.innerHTML = CAPACITY_ORDER.map(id => rotationCard(id, start)).join('');
  }


  async function renderForecast() {
    const token = forecasts.begin('forecast');
    try {
    const start = document.getElementById('forecastStart').value;
    if (!start) return;

    const current = state();
    const daysInput = document.getElementById('forecastDays');
    const days = clamp(Math.round(Number(daysInput?.value || current.ui?.forecastDays || 7)), 1, 120);
    if (daysInput) daysInput.value = days;
    current.ui ||= store.clone(DEFAULT_UI);
    current.ui.forecastDays = days;

    const ids = selectedForecastIds();
    const capacityIds = selectedCapacityIds();

    // Next X Days is a list of useful forecast rows, not necessarily X consecutive
    // calendar dates. Extend the simulation far enough to replace dates where all
    // selected events are impossible (0%).
    const hasUltra = ids.some(id => EVENTS[id].tier === 'ultra');
    const hasNonUltra = ids.some(id => EVENTS[id].tier === 'non-ultra');
    const densityFactor = hasUltra && hasNonUltra ? 1.5 : hasUltra ? 2.1 : 2.5;
    let forecastHorizon = Math.min(365, Math.max(days, Math.ceil(days * densityFactor) + 7));
    let probabilities = await forecasts.run('simulateForecast', [start, forecastHorizon], token);
    if (token.aborted) return;
    let displaySelection = forecastDisplayDates(probabilities, ids, days);
    while (displaySelection.dates.length < days && forecastHorizon < 365) {
      forecastHorizon = Math.min(365, forecastHorizon + Math.max(14, Math.ceil(days / 2)));
      probabilities = await forecasts.run('simulateForecast', [start, forecastHorizon], token);
      if (token.aborted) return;
      displaySelection = forecastDisplayDates(probabilities, ids, days);
    }
    const displayDates = displaySelection.dates;
    const capacityWeeksInput = document.getElementById('capacityWeeks');
    const capacityWeeks = clamp(Math.round(Number(capacityWeeksInput?.value || current.ui?.capacityWeeks || 4)), 1, 52);
    if (capacityWeeksInput) capacityWeeksInput.value = capacityWeeks;
    current.ui.capacityWeeks = capacityWeeks;
    const capacityProbabilities = await forecasts.run('simulateCapacityForecast', [start, capacityWeeks], token);
    if (token.aborted) return;
    const nextHits = await forecasts.run('simulateNextHitForecast', [start], token);
    if (token.aborted) return;
    const sundayDates = Object.keys(capacityProbabilities);
    const sundayCount = document.getElementById('capacitySundayCount');
    if (sundayCount) sundayCount.textContent = `${capacityWeeks} ${capacityWeeks === 1 ? 'Sunday' : 'Sundays'}`;
    const title = document.getElementById('forecastWindowTitle');
    if (title) title.textContent = `Next ${days} ${days === 1 ? 'day' : 'days'}`;

    const history = store.createStore(store.clone(state()), start);
    const historicalModel = model.createModel(history);
    const table = document.getElementById('forecastTable');
    table.innerHTML = `<thead><tr><th>Date</th>${ids.map(id => `<th class="event-head"><span class="dot ${EVENTS[id].color}"></span>${EVENTS[id].short}</th>`).join('')}</tr></thead><tbody>` +
      displayDates.map((date, index) => { const skipped = diffDays(index ? displayDates[index - 1] : start, date) - 1; const separator = skipped > 0 ? `<tr class="forecast-gap-row"><td colspan="${ids.length + 1}">${skipped} ${skipped === 1 ? 'date' : 'dates'} skipped — all selected events were 0%</td></tr>` : ''; const view = eventDateView(date, { month: 'short', day: 'numeric' }); return `${separator}<tr><td class="date-cell"><strong>${view.weekday}, ${view.text}</strong><span>${view.shifted ? `${view.localIso} local · ${date} Pacific` : date}</span></td>${ids.map(id => {
        const probability = probabilities[date][id];
        const tip = escapeHtml(forecastDetail(id, date, probability, history, historicalModel, start)).replaceAll('\n', '&#10;');
        return `<td><span class="prob ${probabilityClass(probability)}" data-tip="${tip}">${pct(probability)}</span></td>`;
      }).join('')}</tr>`; }).join('') + '</tbody>';

    const skippedNote = document.getElementById('forecastSkippedNote');
    if (skippedNote) {
      const skipped = displaySelection.skipped;
      const shortfall = Math.max(0, days - displayDates.length);
      skippedNote.hidden = skipped === 0 && shortfall === 0;
      if (skipped > 0 || shortfall > 0) {
        const parts = [];
        if (skipped > 0) parts.push(`Skipped ${skipped} ${skipped === 1 ? 'date' : 'dates'} where every selected event was 0%.`);
        if (shortfall > 0) parts.push(`Only ${displayDates.length} qualifying dates were found within the ${forecastHorizon}-day look-ahead limit.`);
        skippedNote.textContent = parts.join(' ');
      }
    }

    const capacityTable = document.getElementById('capacityForecastTable');
    if (capacityTable) {
      capacityTable.innerHTML = `<thead><tr><th>Sunday</th>${capacityIds.map(id => `<th class="event-head"><span class="dot ${EVENTS[id].color}"></span>${EVENTS[id].short}</th>`).join('')}</tr></thead><tbody>` +
        sundayDates.map(date => { const view = eventDateView(date, { month: 'short', day: 'numeric' }); return `<tr><td class="date-cell"><strong>${view.weekday}, ${view.text}</strong><span>${view.shifted ? `${date} Pacific Sunday · ${view.localIso} local` : `${date} Pacific Sunday`}</span></td>${capacityIds.map(id => {
            const probability = capacityProbabilities[date][id];
            const tip = escapeHtml(forecastDetail(id, date, probability, history, historicalModel, start)).replaceAll('\n', '&#10;');
            return `<td><span class="prob ${probabilityClass(probability)}" data-tip="${tip}">${pct(probability)}</span></td>`;
          }).join('')}</tr>`; }).join('') + '</tbody>';
    }

    store.saveState();
    bindTips();
    renderNextLikely(start, ids, 'nextLikelyCards', nextHits);
    renderNextLikely(start, capacityIds, 'capacityNextLikelyCards', nextHits);
    renderRotationCards(start);
    renderCapacityRotationCards(start);
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error(error);
        toast('Could not update predictions. Change the date or retry.');
      }
    } finally { forecasts.end(token); }
  }

  function dayEventTile(event, probability, tierLabel, meta = '') {
    const percentage = pct(probability);
    return `<article class="today-event-tile tomorrow-pick ${event.color}"><div class="today-event-icon">${event.icon}</div><div class="tomorrow-event-content"><div class="tomorrow-tier">${tierLabel}</div><div class="today-event-name"><span class="dot ${event.color}"></span>${event.label}</div><div class="tomorrow-chance"><span class="prob ${probabilityClass(probability)}">${percentage}</span><span class="today-event-meta">chance</span></div>${meta ? `<div class="today-event-meta">${meta}</div>` : ''}</div></article>`;
  }

  function unavailableTomorrowTile(tierLabel) {
    return `<article class="today-event-tile empty tomorrow-pick"><div class="today-event-icon">—</div><div class="tomorrow-event-content"><div class="tomorrow-tier">${tierLabel}</div><div class="today-event-name">No event expected</div><div class="tomorrow-chance"><span class="prob low">0%</span><span class="today-event-meta">chance</span></div><div class="today-event-meta">No tracked ${tierLabel} event is forecast for tomorrow.</div></div></article>`;
  }

  async function renderTomorrowEvents() {
    const token = forecasts.begin('tomorrow');
    try {
    const box = document.getElementById('tomorrowEventTiles');
    const badge = document.getElementById('tomorrowEventDateBadge');
    if (!box || !badge) return;

    const today = clock.currentEventDate();
    const tomorrow = addDays(today, 1);
    const view = eventDateView(tomorrow, { month: 'short', day: 'numeric', year: 'numeric' });
    badge.textContent = view.shifted
      ? `${view.text} local · ${fmtDate(tomorrow, { month: 'short', day: 'numeric' })} Pacific`
      : view.text;

    if (tomorrow.slice(5) === '07-14') {
      box.innerHTML = `<article class="today-event-tile pending"><div class="today-event-icon">🥚</div><div><div class="today-event-name">Egg Day special events</div><div class="muted small">July 14 is intentionally excluded from probability modeling.</div></div></article>`;
      return;
    }

    const liveForecast = await forecasts.run('simulateForecast', [today, 1], token);
    if (token.aborted) return;
    const tomorrowForecast = liveForecast[tomorrow] || {};
    const fixed = model.fixedNonUltraEvent(tomorrow);
    const isSunday = parseDate(tomorrow).getDay() === 0;
    const fixedMeta = fixed ? fixed.note || 'Fixed weekly Non-Ultra event.' : '';
    const nonUltraPick = fixed
      ? { event: fixed, probability: 1, meta: fixedMeta }
      : (() => {
          const best = model.highestProbability(tomorrowForecast, [...NON_ULTRA_MIDWEEK_POOL]);
          return best && best.probability > 0 ? { event: EVENTS[best.id], probability: best.probability, meta: 'Highest modeled Non-Ultra chance.' } : null;
        })();

    const ultraCandidates = [...ULTRA_MIDWEEK_POOL];
    const ultraBest = model.highestProbability(tomorrowForecast, ultraCandidates);
    const ultraPick = ultraBest && ultraBest.probability > 0
      ? { event: EVENTS[ultraBest.id], probability: ultraBest.probability, meta: 'Highest modeled Ultra daily-event chance.' }
      : null;

    const capacityRows = isSunday ? CAPACITY_ORDER.flatMap(id => {
      const probability = Number(tomorrowForecast[id] || 0);
      if (!(probability > 0)) return [];
      const tier = EVENTS[id].tier === 'ultra' ? 'Ultra' : 'Non-Ultra';
      return [`<div class="tomorrow-capacity-chance"><span class="tomorrow-tier">${tier}</span><span class="prob ${probabilityClass(probability)}">${pct(probability)}</span><span class="today-event-meta">chance</span></div>`];
    }) : [];
    const capacityTile = capacityRows.length
      ? `<article class="today-event-tile tomorrow-capacity-tile purple"><div class="today-event-icon">🚀</div><div class="tomorrow-event-content"><div class="today-event-name">Mission Capacity Boost</div><div class="today-event-meta">Double ship capacity</div>${capacityRows.join('')}</div></article>`
      : '';

    box.innerHTML = [
      nonUltraPick ? dayEventTile(nonUltraPick.event, nonUltraPick.probability, 'Non-Ultra', nonUltraPick.meta) : unavailableTomorrowTile('Non-Ultra'),
      ultraPick ? dayEventTile(ultraPick.event, ultraPick.probability, 'Ultra', ultraPick.meta) : unavailableTomorrowTile('Ultra'),
      capacityTile
    ].join('');
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error(error);
        toast('Could not update predictions. Change the date or retry.');
      }
    } finally { forecasts.end(token); }
  }

  function renderTodayEvents() {
    const box = document.getElementById('todayEventTiles');
    const badge = document.getElementById('todayEventDateBadge');
    if (!box || !badge) return;

    const today = clock.currentEventDate();
    const confirmed = store.getConfirmedDays();
    const hasDay = Object.prototype.hasOwnProperty.call(confirmed, today);
    const ids = hasDay ? (confirmed[today] || []).filter(id => MODEL_ORDER.includes(id)) : [];
    const fixed = model.fixedNonUltraEvent(today);
    const view = eventDateView(today, { month: 'short', day: 'numeric', year: 'numeric' });

    badge.textContent = view.shifted
      ? `${view.text} local · ${fmtDate(today, { month: 'short', day: 'numeric' })} Pacific`
      : view.text;

    if (!hasDay && !fixed) {
      box.innerHTML = `<article class="today-event-tile pending"><div class="today-event-icon">↻</div><div><div class="today-event-name">Waiting for today’s data</div><div class="muted small">Sync Wasmegg to load today’s events.</div></div></article>`;
      return;
    }

    if (!ids.length && !fixed) {
      box.innerHTML = `<article class="today-event-tile empty"><div class="today-event-icon">—</div><div><div class="today-event-name">No modeled events today</div><div class="muted small">No tracked event is recorded for today.</div></div></article>`;
      return;
    }

    const fixedTile = fixed
      ? `<article class="today-event-tile ${fixed.color}"><div class="today-event-icon">${fixed.icon}</div><div><div class="today-event-name"><span class="dot ${fixed.color}"></span>${fixed.label}</div><div class="today-event-meta">Non-Ultra · Fixed weekly event</div></div></article>`
      : '';
    const syncedTiles = ids.map(id => {
      const event = EVENTS[id];
      const tier = event.tier === 'ultra' ? 'Ultra' : 'Non-Ultra';
      return `<article class="today-event-tile ${event.color}"><div class="today-event-icon">${event.icon}</div><div><div class="today-event-name"><span class="dot ${event.color}"></span>${event.label}</div><div class="today-event-meta">${tier} · ${familyLabel(event)}</div></div></article>`;
    }).join('');
    const pendingTile = !hasDay
      ? `<article class="today-event-tile pending compact-pending"><div class="today-event-icon">↻</div><div><div class="today-event-name">Other events pending sync</div><div class="muted small">The fixed Non-Ultra event is known; Wasmegg has not confirmed the rest of today yet.</div></div></article>`
      : '';
    box.innerHTML = fixedTile + syncedTiles + pendingTile;
  }

  function renderLatest() {
    const liveHistory = store.createStore(store.clone(state()), clock.currentEventDate());
    const day = liveHistory.latestConfirmedDay();
    const events = (liveHistory.getConfirmedDays()[day] || []).filter(id => ORDER.includes(id));

    const latestView = eventDateView(day);
    document.getElementById('latestConfirmed').textContent = latestView.text;
    let latestText = events.length
      ? events.map(id => EVENTS[id].label).join(' + ')
      : 'Confirmed: no tracked events';

    if (latestView.shifted) latestText += ` · Pacific event date ${day}`;
    document.getElementById('latestConfirmedEvents').textContent = latestText;
    document.getElementById('dataThroughBadge').textContent = `Data through ${fmtEventDate(store.latestDataDate(), { month: 'short', day: 'numeric', year: 'numeric' })}`;
    renderWasmeggSyncStatus();
  }

  function setupChecklist() {
    const wrap = document.getElementById('eventChecklist');
    wrap.innerHTML = ORDER.map(id => `<label class="event-option" data-event="${id}"><input type="checkbox" value="${id}"/><span><span class="dot ${EVENTS[id].color}"></span>${EVENTS[id].label}</span></label>`).join('');
    wrap.querySelectorAll('input').forEach(input => input.addEventListener('change', validateChecklist));
  }

  function selectedEvents() {
    return [...document.querySelectorAll('#eventChecklist input:checked')].map(input => input.value);
  }

  function validateChecklist() {
    const selected = selectedEvents();
    let message = '';

    for (let first = 0; first < selected.length; first += 1) {
      for (let second = first + 1; second < selected.length; second += 1) {
        if (model.conflicts(selected[first], selected[second])) {
          message = `${EVENTS[selected[first]].label} conflicts with ${EVENTS[selected[second]].label}.`;
        }
      }
    }

    document.getElementById('validationMsg').textContent = message;
    return !message;
  }

  function loadRecordDate(value, { displayDate = false } = {}) {
    const modelDate = displayDate ? modelDateForDisplayDate(value) : value;
    const input = document.getElementById('recordDate');
    input.value = eventDisplayDateIso(modelDate);
    input.dataset.modelDate = modelDate;
    const current = state();
    const selected = current.overrides[modelDate]
      ?? (store.getConfirmedDays()[modelDate] || []).filter(id => ORDER.includes(id))
      ?? ORDER.filter(id => store.getAllEventDates(id).includes(modelDate));
    document.querySelectorAll('#eventChecklist input').forEach(inputElement => {
      inputElement.checked = selected.includes(inputElement.value);
    });
    validateChecklist();
  }

  async function renderCalendar() {
    const token = forecasts.begin('calendar');
    try {
    const year = calendarCursor.getFullYear();
    const month = calendarCursor.getMonth();
    document.getElementById('calendarMonthLabel').textContent = new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    const current = state();
    current.ui ||= store.clone(DEFAULT_UI);
    const showConfirmed = current.ui.calendarShowConfirmed !== false;
    const showPredictions = current.ui.calendarShowPredictions !== false;
    const showSchedule = current.ui.calendarShowSchedule !== false;
    const showNonUltra = current.ui.calendarShowNonUltra !== false;
    const showUltra = current.ui.calendarShowUltra !== false;
    const minProbability = clamp(Number(current.ui.calendarMinProbability ?? DEFAULT_UI.calendarMinProbability), 0, 100);

    const confirmedToggle = document.getElementById('calendarShowConfirmed');
    const predictionsToggle = document.getElementById('calendarShowPredictions');
    const nonUltraToggle = document.getElementById('calendarShowNonUltra');
    const ultraToggle = document.getElementById('calendarShowUltra');
    const thresholdInput = document.getElementById('calendarMinProbability');
    document.getElementById('calendarShowSchedule').checked = showSchedule;
    if (confirmedToggle) confirmedToggle.checked = showConfirmed;
    if (predictionsToggle) predictionsToggle.checked = showPredictions;
    if (nonUltraToggle) nonUltraToggle.checked = showNonUltra;
    if (ultraToggle) ultraToggle.checked = showUltra;
    if (thresholdInput) thresholdInput.value = minProbability;

    const first = new Date(year, month, 1, 12);
    const startDate = new Date(year, month, 1 - first.getDay(), 12);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 41);
    const startDisplayIso = isoDate(startDate);
    const endDisplayIso = isoDate(endDate);

    const confirmedMap = {};
    if (showConfirmed) {
      const canonicalMap = store.eventMapForCalendar();
      Object.entries(canonicalMap).forEach(([canonicalDate, ids]) => {
        if (canonicalDate > clock.currentEventDate()) return;
        const localDate = eventDisplayDateIso(canonicalDate);
        if (localDate < startDisplayIso || localDate > endDisplayIso) return;
        const filtered = ids.filter(id => {
          const tier = EVENTS[id].tier;
          return (tier === 'ultra' && showUltra) || (tier === 'non-ultra' && showNonUltra);
        });
        if (!filtered.length) return;
        (confirmedMap[localDate] ||= []).push(...filtered.map(id => ({ id, canonicalDate })));
      });
    }

    const predictionMap = {};
    const referenceDate = document.getElementById('forecastStart')?.value || clock.currentEventDate();
    let predictionHorizon = 0;
    let predictionLimited = false;
    if (showPredictions && (showNonUltra || showUltra)) {
      const maxCanonical = addDays(modelDateForDisplayDate(endDisplayIso), 1);
      predictionHorizon = Math.max(0, diffDays(referenceDate, maxCanonical));
      if (predictionHorizon > CALENDAR_PREDICTION_HORIZON) {
        predictionHorizon = CALENDAR_PREDICTION_HORIZON;
        predictionLimited = true;
      }
      if (predictionHorizon > 0) {
        const probabilities = await forecasts.run('simulateForecast', [referenceDate, predictionHorizon], token);
        if (token.aborted) return;
        Object.entries(probabilities).forEach(([canonicalDate, row]) => {
          const localDate = eventDisplayDateIso(canonicalDate);
          if (localDate < startDisplayIso || localDate > endDisplayIso) return;
          const picks = model.calendarPredictionPicks(canonicalDate, row, minProbability / 100, { showNonUltra, showUltra }).filter(pick => !pick.fixed);
          if (picks.length) (predictionMap[localDate] ||= []).push(...picks.map(pick => ({ ...pick, canonicalDate })));
        });
      }
    }

    if (showSchedule && showNonUltra) {
      for (let offset = 0; offset < 42; offset += 1) {
        const localDate = addDays(startDisplayIso, offset);
        const canonicalDate = modelDateForDisplayDate(localDate);
        if (canonicalDate < REMOTE_DATA_START) continue;
        const fixed = model.fixedNonUltraEvent(canonicalDate);
        if (fixed) (predictionMap[localDate] ||= []).unshift({ ...fixed, fixed: true, canonicalDate });
      }
    }

    const note = document.getElementById('calendarPredictionNote');
    if (note) {
      if (!showPredictions) note.textContent = 'Prediction overlay is off.';
      else if (predictionHorizon <= 0) note.textContent = 'This calendar range is at or before the forecast reference date, so no future prediction overlay is available.';
      else if (predictionLimited) note.textContent = 'Prediction overlay is limited to 90 days after the forecast reference date to keep the calendar responsive.';
      else note.textContent = `Forecast as of ${referenceDate} Pacific: strongest Ultra and Non-Ultra candidates at or above ${minProbability}%. Regular schedule entries are controlled separately.`;
    }

    if (note) {
      const shifted = modelDateForDisplayDate(startDisplayIso) !== startDisplayIso;
      note.textContent += ` Regular schedule uses Friday–Monday Pacific event days${shifted ? '; local dates differ — each scheduled entry shows its Pacific date' : ''}. Scheduled entries are inferred, not confirmed history; exceptions may occur.`;
    }
    const grid = document.getElementById('calendarGrid');
    const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let html = weekdayNames.map(name => `<div class="calendar-weekday">${name}</div>`).join('');

    for (let index = 0; index < 42; index += 1) {
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + index);
      const dateString = isoDate(date);
      const outside = date.getMonth() !== month;
      const confirmedRows = confirmedMap[dateString] || [];
      const predictedRows = predictionMap[dateString] || [];
      const confirmedChips = confirmedRows.map(row => `<span class="event-chip ${EVENTS[row.id].color} confirmed-chip" title="Confirmed: ${EVENTS[row.id].label}${row.canonicalDate !== dateString ? ` · ${row.canonicalDate} Pacific` : ''}">${EVENTS[row.id].icon} ${EVENTS[row.id].short}</span>`).join('');
      const predictedChips = predictedRows.map(row => {
        const label = row.short || row.label;
        const suffix = row.fixed ? 'Scheduled' : pct(row.probability);
        const title = row.fixed ? `Regular schedule: ${row.label} · ${dateString} local · ${row.canonicalDate} Pacific; inferred, not confirmed` : `Predicted: ${row.label} · ${pct(row.probability)}`;
        return `<span class="event-chip ${row.color} predicted-chip ${row.fixed ? 'fixed-chip' : ''}" title="${escapeHtml(title)}">${row.icon} ${escapeHtml(label)} <span class="chip-prob">${suffix}</span>${row.fixed && row.canonicalDate !== dateString ? `<small class="schedule-zone">${row.canonicalDate} Pacific</small>` : ''}</span>`;
      }).join('');
      const modelDate = confirmedRows[0]?.canonicalDate || predictedRows[0]?.canonicalDate || modelDateForDisplayDate(dateString);
      html += `<div class="calendar-day ${outside ? 'outside' : ''}" data-date="${modelDate}"><div class="day-num">${date.getDate()}</div>${confirmedChips}${predictedChips}</div>`;
    }

    grid.innerHTML = html;
    grid.querySelectorAll('.calendar-day').forEach(element => element.addEventListener('dblclick', () => {
      switchTab('forecast');
      loadRecordDate(element.dataset.date);
      document.querySelector('#recordDate').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error(error);
        toast('Could not update predictions. Change the date or retry.');
      }
    } finally { forecasts.end(token); }
  }

  function renderGapHistory() {
    const select = document.getElementById('gapEventSelect');
    if (!select.options.length) {
      select.innerHTML = `<optgroup label="Daily events">${MAIN_ORDER.map(id => `<option value="${id}">${EVENTS[id].label}</option>`).join('')}</optgroup><optgroup label="Mission Capacity Boost">${CAPACITY_ORDER.map(id => `<option value="${id}">${EVENTS[id].label}</option>`).join('')}</optgroup>`;
    }

    const id = select.value || ORDER[0];
    const stats = store.gapStats(id);
    const gaps = store.historicalGaps(id);
    const counts = stats.reduce((sum, row) => sum + row.count, 0);
    const weightedTotal = stats.reduce((sum, row) => sum + row.weighted, 0);
    const maxWeighted = Math.max(...stats.map(row => row.weighted), 1);
    const rawMin = gaps.length ? Math.min(...gaps.map(row => row.gap)) : 0;
    const rawMax = gaps.length ? Math.max(...gaps.map(row => row.gap)) : 0;
    const common = [...stats].sort((a, b) => b.weighted - a.weighted)[0];

    document.getElementById('gapSummary').innerHTML = [
      ['Completed gaps', counts],
      ['Observed range', `${rawMin}–${rawMax} days`],
      ['Most weighted gap', common ? `${common.gap} days` : '—'],
      ['Coverage starts', fmtDate(EVENTS[id].coverageStart, { month: 'short', day: 'numeric', year: 'numeric' })]
    ].map(([key, value]) => `<article class="hero-card"><div class="eyebrow">${key}</div><div class="big-value">${value}</div></article>`).join('');

    document.getElementById('gapTable').innerHTML = '<thead><tr><th>Gap</th><th>Raw count</th><th>Raw frequency</th><th>Weighted count</th><th>Weighted share</th><th>Conditional hazard</th><th>Relative weight</th></tr></thead><tbody>' +
      stats.map(row => {
        const survivor = stats.filter(item => item.gap >= row.gap).reduce((sum, item) => sum + item.weighted, 0);
        const hazard = survivor ? row.weighted / survivor : 0;
        return `<tr><td><strong>${row.gap} days</strong></td><td>${row.count}</td><td>${counts ? pct(row.count / counts) : '—'}</td><td>${row.weighted.toFixed(1)}</td><td>${weightedTotal ? pct(row.weighted / weightedTotal) : '—'}</td><td>${pct(hazard)}</td><td class="bar-wrap"><div class="bar"><span style="width:${(row.weighted / maxWeighted * 100).toFixed(1)}%"></span></div></td></tr>`;
      }).join('') + '</tbody>';
  }

  function dataRows() {
    const current = state();
    const cacheKey = `${current.remote?.syncedAt || 'seed'}|${JSON.stringify(current.overrides)}`;
    if (cacheKey === dataRowsCacheKey) return dataRowsCache;

    const rows = [];
    const map = {};
    MODEL_ORDER.forEach(id => store.getAllEventDates(id).forEach(date => {
      (map[date] ||= []).push(id);
    }));

    Object.keys(map).sort().reverse().forEach(date => map[date].forEach(id => {
      let source = 'Seed';
      if (ORDER.includes(id) && current.overrides[date] !== undefined) source = 'Local override';
      else if (store.hasRemoteData() && Array.isArray(current.remote.events?.[id]) && current.remote.events[id].includes(date)) source = 'Wasmegg';
      rows.push({ date, id, source });
    }));

    dataRowsCacheKey = cacheKey;
    dataRowsCache = rows;
    return rows;
  }

  function renderData({ resetLimit = false } = {}) {
    const current = state();
    if (resetLimit) dataVisibleRows = DATA_PAGE_SIZE;
    const rows = dataRows();
    const visibleRows = rows.slice(0, dataVisibleRows);

    document.getElementById('dataStats').innerHTML = [
      ['Event records', rows.length],
      ['Model event types', MODEL_ORDER.length],
      ['Local overrides', Object.keys(current.overrides).length],
      ['Latest data', fmtDate(store.latestDataDate(), { month: 'short', day: 'numeric', year: 'numeric' })]
    ].map(([key, value]) => `<article class="hero-card"><div class="eyebrow">${key}</div><div class="big-value">${value}</div></article>`).join('');

    document.getElementById('dataTable').innerHTML = '<thead><tr><th>Date</th><th>Event</th><th>Family</th><th>Source</th></tr></thead><tbody>' +
      visibleRows.map(row => { const view = eventDateView(row.date, { month: 'short', day: 'numeric', year: 'numeric' }); return `<tr><td>${view.text}${view.shifted ? `<br><span class="muted small">${row.date} Pacific</span>` : ''}</td><td><span class="dot ${EVENTS[row.id].color}"></span>${EVENTS[row.id].label}</td><td>${familyLabel(EVENTS[row.id])}</td><td>${row.source}</td></tr>`; }).join('') +
      '</tbody>';

    const status = document.getElementById('dataRowsStatus');
    if (status) status.textContent = rows.length ? `Showing ${Math.min(visibleRows.length, rows.length)} of ${rows.length} records` : 'No records';
    const moreButton = document.getElementById('dataShowMoreBtn');
    if (moreButton) {
      moreButton.hidden = visibleRows.length >= rows.length;
      moreButton.textContent = `Show ${Math.min(DATA_PAGE_SIZE, Math.max(0, rows.length - visibleRows.length))} more`;
    }
    renderWasmeggSyncStatus();
  }

  function renderAll() {
    const currentDay = clock.currentEventDate();
    document.getElementById('recordDate').max = eventDisplayDateIso(currentDay);
    const referenceInput = document.getElementById('forecastStart');
    if (!referenceInput.value) { referenceInput.value = currentDay; followCurrentDay = true; }
    const reference = referenceInput.value;
    const referenceView = eventDateView(reference);
    document.getElementById('referenceMode').textContent = `${followCurrentDay ? 'Following current event day' : 'Selected reference day'} · ${reference} Pacific${referenceView.shifted ? ` · ${referenceView.localIso} local` : ''}`;
    renderTodayEvents();
    renderTomorrowEvents();
    renderLatest();
    renderForecast();
    if (currentTab === 'calendar') renderCalendar();
    if (currentTab === 'gaps') renderGapHistory();
    if (currentTab === 'data') renderData();
  }

  function switchTab(id) {
    currentTab = id;
    document.querySelectorAll('.tab').forEach(element => element.classList.toggle('active', element.dataset.tab === id));
    document.querySelectorAll('.panel-section').forEach(element => element.classList.toggle('active', element.id === id));
    if (id === 'calendar') renderCalendar();
    if (id === 'gaps') renderGapHistory();
    if (id === 'data') renderData({ resetLimit: true });
  }

  function exportData() {
    const current = state();
    const payload = {
      app: 'Egg Event Lab',
      appVersion: APP_VERSION,
      version: EXPORT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      seedThrough: TODAY_SEED,
      overrides: current.overrides,
      settings: current.settings,
      ui: current.ui,
      remote: current.remote,
      note: 'Import this file back into Egg Event Lab to restore local confirmations, Wasmegg cache, model settings, and forecast-view preferences.'
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `egg-event-lab-${clock.currentEventDate()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const object = JSON.parse(reader.result);
        const rawImportedEvents = Array.isArray(object.ui?.forecastEvents) ? object.ui.forecastEvents : null;
        const selectionVersion = Number(object.ui?.forecastSelectionVersion || 1);
        let importedEvents = rawImportedEvents
          ? rawImportedEvents.filter(id => MAIN_ORDER.includes(id))
          : [...DEFAULT_UI.forecastEvents];
        const previousUnifiedDefault = selectionVersion < DEFAULT_UI.forecastSelectionVersion
          && rawImportedEvents
          && rawImportedEvents.length === MAIN_ORDER.length
          && MAIN_ORDER.every(id => rawImportedEvents.includes(id));
        if (previousUnifiedDefault) importedEvents = [...DEFAULT_UI.forecastEvents];
        const importedCapacityEvents = Array.isArray(object.ui?.capacityEvents)
          ? object.ui.capacityEvents.filter(id => CAPACITY_ORDER.includes(id))
          : rawImportedEvents
            ? rawImportedEvents.filter(id => CAPACITY_ORDER.includes(id))
            : [...CAPACITY_ORDER];

        const nextState = {
          overrides: store.migrateLegacyOverrides(object.overrides || {}, object.remote?.confirmedDays, object.ui?.unifiedDailyEvents !== true),
          settings: store.normalizeSettings(object.settings || {}),
          ui: {
            ...store.clone(DEFAULT_UI),
            ...(object.ui || {}),
            unifiedDailyEvents: true,
            forecastDays: clamp(Number(object.ui?.forecastDays || 7), 1, 120),
            forecastSelectionVersion: DEFAULT_UI.forecastSelectionVersion,
            forecastEvents: importedEvents.length ? importedEvents : [...DEFAULT_UI.forecastEvents],
            capacityWeeks: clamp(Number(object.ui?.capacityWeeks || 4), 1, 52),
            capacityEvents: importedCapacityEvents.length ? importedCapacityEvents : [...CAPACITY_ORDER],
            calendarShowConfirmed: object.ui?.calendarShowConfirmed !== false,
            calendarShowPredictions: object.ui?.calendarShowPredictions !== false,
            calendarShowNonUltra: object.ui?.calendarShowNonUltra !== false,
            calendarShowUltra: object.ui?.calendarShowUltra !== false,
            calendarMinProbability: clamp(Number(object.ui?.calendarMinProbability ?? DEFAULT_UI.calendarMinProbability), 0, 100)
          },
          remote: {
            ...store.clone(DEFAULT_REMOTE),
            ...(object.remote || {}),
            autoSync: object.remote?.autoSync !== false
          }
        };

        if (nextState.remote.rangeStart !== REMOTE_DATA_START || nextState.remote.schemaVersion !== REMOTE_SCHEMA_VERSION) {
          nextState.remote = { ...store.clone(DEFAULT_REMOTE), autoSync: nextState.remote.autoSync };
        }

        store.replaceState(nextState);
        model.invalidateNextHitCache();
        invalidateDataRows();
        store.saveState();
        syncSettingsUI();
        renderForecastEventPicker();
        renderCapacityEventPicker();
        const forecastDays = document.getElementById('forecastDays');
        if (forecastDays) forecastDays.value = state().ui.forecastDays;
        const capacityWeeks = document.getElementById('capacityWeeks');
        if (capacityWeeks) capacityWeeks.value = state().ui.capacityWeeks;
        renderAll();
        toast('Import complete');
      } catch {
        alert('That file is not a valid Egg Event Lab export.');
      }
    };
    reader.readAsText(file);
  }

  function syncSettingsUI() {
    const current = state();
    document.getElementById('weekdayToggle').checked = Boolean(current.settings.weekdayPattern);
    document.getElementById('weightUnder1').value = current.settings.weights.under1;
    document.getElementById('weight1to2').value = current.settings.weights.oneToTwo;
    document.getElementById('weight2plus').value = current.settings.weights.twoPlus;
    const autoSync = document.getElementById('autoSyncToggle');
    if (autoSync) autoSync.checked = current.remote?.autoSync !== false;
    renderWasmeggSyncStatus();
  }

  function bindForecastControls() {
    renderForecastEventPicker();
    renderCapacityEventPicker();

    const pickerToggle = document.getElementById('eventPickerToggle');
    const picker = document.getElementById('forecastEventPicker');
    pickerToggle?.addEventListener('click', () => {
      picker.hidden = !picker.hidden;
      pickerToggle.setAttribute('aria-expanded', String(!picker.hidden));
    });

    const capacityPickerToggle = document.getElementById('capacityPickerToggle');
    const capacityPicker = document.getElementById('capacityEventPicker');
    capacityPickerToggle?.addEventListener('click', () => {
      capacityPicker.hidden = !capacityPicker.hidden;
      capacityPickerToggle.setAttribute('aria-expanded', String(!capacityPicker.hidden));
    });

    const forecastDays = document.getElementById('forecastDays');
    if (forecastDays) {
      forecastDays.value = clamp(Number(state().ui?.forecastDays || 7), 1, 120);
      forecastDays.addEventListener('change', () => {
        forecastDays.value = clamp(Math.round(Number(forecastDays.value) || 7), 1, 120);
        state().ui.forecastDays = Number(forecastDays.value);
        store.saveState();
        renderForecast();
      });
    }

    const capacityWeeks = document.getElementById('capacityWeeks');
    if (capacityWeeks) {
      capacityWeeks.value = clamp(Number(state().ui?.capacityWeeks || 4), 1, 52);
      capacityWeeks.addEventListener('change', () => {
        capacityWeeks.value = clamp(Math.round(Number(capacityWeeks.value) || 4), 1, 52);
        state().ui.capacityWeeks = Number(capacityWeeks.value);
        store.saveState();
        renderForecast();
      });
    }

    document.getElementById('forecastStart').addEventListener('change', () => {
      followCurrentDay = false;
      renderAll();
    });
    document.getElementById('currentEventDayBtn').addEventListener('click', () => {
      followCurrentDay = true;
      document.getElementById('forecastStart').value = clock.currentEventDate();
      renderAll();
    });
  }

  function bindRecordControls() {
    document.getElementById('recordDate').addEventListener('change', event => loadRecordDate(event.target.value, { displayDate: true }));
    document.getElementById('todayBtn').addEventListener('click', () => loadRecordDate(clock.currentEventDate()));
    document.getElementById('saveDayBtn').addEventListener('click', () => {
      if (!validateChecklist()) return;
      const displayDate = document.getElementById('recordDate').value;
      if (!displayDate) return;
      const date = modelDateForDisplayDate(displayDate);
      if (date > clock.currentEventDate()) {
        document.getElementById('validationMsg').textContent = 'Confirm events only after their event day has started. Future entries are not used by forecasts.';
        return;
      }
      state().overrides[date] = selectedEvents();
      model.invalidateNextHitCache();
      invalidateDataRows();
      store.saveState();
      renderAll();
      toast(`Saved ${fmtEventDate(date, { month: 'short', day: 'numeric' })}`);
    });
    document.getElementById('clearDayBtn').addEventListener('click', () => {
      const displayDate = document.getElementById('recordDate').value;
      const date = modelDateForDisplayDate(displayDate);
      delete state().overrides[date];
      model.invalidateNextHitCache();
      invalidateDataRows();
      store.saveState();
      loadRecordDate(date);
      renderAll();
      toast('Local override cleared');
    });
  }

  function bindDataControls() {
    document.getElementById('exportBtn').addEventListener('click', exportData);
    document.getElementById('importInput').addEventListener('change', event => {
      if (event.target.files[0]) importData(event.target.files[0]);
      event.target.value = '';
    });
    document.getElementById('syncWasmeggBtn')?.addEventListener('click', () => syncWasmegg());
    document.getElementById('syncWasmeggDataBtn')?.addEventListener('click', () => syncWasmegg());
    document.getElementById('autoSyncToggle')?.addEventListener('change', event => {
      state().remote ||= store.clone(DEFAULT_REMOTE);
      state().remote.autoSync = Boolean(event.target.checked);
      store.saveState();
      if (state().remote.autoSync) syncWasmegg();
    });
    document.getElementById('dataShowMoreBtn')?.addEventListener('click', () => {
      dataVisibleRows += DATA_PAGE_SIZE;
      renderData();
    });
  }

  function bindSettingsControls() {
    ['weekdayToggle', 'weightUnder1', 'weight1to2', 'weight2plus'].forEach(id => {
      document.getElementById(id).addEventListener('change', () => {
        const current = state();
        current.settings.weekdayPattern = document.getElementById('weekdayToggle').checked;
        current.settings.weights.under1 = Number(document.getElementById('weightUnder1').value) || 0;
        current.settings.weights.oneToTwo = Number(document.getElementById('weight1to2').value) || 0;
        current.settings.weights.twoPlus = Number(document.getElementById('weight2plus').value) || 0;
        model.invalidateNextHitCache();
        store.saveState();
        renderAll();
        if (currentTab !== 'gaps') renderGapHistory();
      });
    });
  }

  function bindCalendarControls() {
    const bindings = [
      ['calendarShowConfirmed', 'calendarShowConfirmed', 'checked'],
      ['calendarShowPredictions', 'calendarShowPredictions', 'checked'],
      ['calendarShowSchedule', 'calendarShowSchedule', 'checked'],
      ['calendarShowNonUltra', 'calendarShowNonUltra', 'checked'],
      ['calendarShowUltra', 'calendarShowUltra', 'checked']
    ];
    bindings.forEach(([elementId, stateKey]) => {
      document.getElementById(elementId)?.addEventListener('change', event => {
        state().ui[stateKey] = Boolean(event.target.checked);
        store.saveState();
        renderCalendar();
      });
    });
    document.getElementById('calendarMinProbability')?.addEventListener('change', event => {
      const value = clamp(Math.round(Number(event.target.value) || 0), 0, 100);
      event.target.value = value;
      state().ui.calendarMinProbability = value;
      store.saveState();
      renderCalendar();
    });
  }

  function bindNavigationControls() {
    document.querySelectorAll('.tab').forEach(element => element.addEventListener('click', () => switchTab(element.dataset.tab)));
    document.getElementById('prevMonth').addEventListener('click', () => {
      calendarCursor.setMonth(calendarCursor.getMonth() - 1);
      renderCalendar();
    });
    document.getElementById('nextMonth').addEventListener('click', () => {
      calendarCursor.setMonth(calendarCursor.getMonth() + 1);
      renderCalendar();
    });
    document.getElementById('gapEventSelect').addEventListener('change', renderGapHistory);
  }

  function bindResetControl() {
    document.getElementById('resetBtn').addEventListener('click', () => {
      if (!confirm('Reset all local confirmations and model settings? Seed history will remain.')) return;

      store.resetState();
      model.invalidateNextHitCache();
      invalidateDataRows();
      syncSettingsUI();
      renderForecastEventPicker();
      renderCapacityEventPicker();
      const forecastDays = document.getElementById('forecastDays');
      if (forecastDays) forecastDays.value = state().ui.forecastDays;
      const capacityWeeks = document.getElementById('capacityWeeks');
      if (capacityWeeks) capacityWeeks.value = state().ui.capacityWeeks;
      loadRecordDate(store.latestConfirmedDay());
      renderAll();
      toast('Local data reset');
      if (state().remote.autoSync) syncWasmegg({ silent: true });
    });
  }

  function setup() {
    const versionBadge = document.getElementById('appVersionBadge');
    if (versionBadge) versionBadge.textContent = `v${APP_VERSION}`;

    setupChecklist();
    syncSettingsUI();

    const modelToday = clock.currentEventDate();
    const latest = store.latestConfirmedDay();
    const defaultStart = modelToday;
    document.getElementById('forecastStart').value = defaultStart;
    loadRecordDate(latest > modelToday ? modelToday : latest);
    calendarCursor = parseDate(eventDisplayDateIso(latest));

    bindNavigationControls();
    bindCalendarControls();
    bindForecastControls();
    bindRecordControls();
    bindDataControls();
    bindSettingsControls();
    bindResetControl();

    renderClockStatus();
    renderAll();
    startEventDayWatcher();
    if (state().remote?.autoSync !== false) syncWasmegg({ silent: true });
  }

  root.EggEventLab.ui = {
    setup,
    renderAll,
    renderForecast,
    renderGapHistory,
    renderCalendar,
    renderData,
    syncWasmegg
  };
})(typeof window !== 'undefined' ? window : globalThis);
