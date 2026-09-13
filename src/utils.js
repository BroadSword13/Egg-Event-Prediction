(function (root) {
  'use strict';

  const { DAY, ANNIVERSARY_MM_DD, MODEL_TIME_ZONE, EVENT_START_HOUR } = root.EggEventLab.config;

  function parseDate(value) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  function isoDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function addDays(value, days) {
    const date = parseDate(value);
    date.setDate(date.getDate() + days);
    return isoDate(date);
  }

  function diffDays(a, b) {
    return Math.round((parseDate(b) - parseDate(a)) / DAY);
  }

  function fmtDate(value, options = { month: 'short', day: 'numeric', year: 'numeric' }) {
    return parseDate(value).toLocaleDateString(undefined, options);
  }

  function weekdayShort(value) {
    return parseDate(value).toLocaleDateString(undefined, { weekday: 'short' });
  }


  function timeZoneParts(date, timeZone) {
    const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23'
    });
    const parts = Object.fromEntries(formatter.formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]));
    return {
      year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
      hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second)
    };
  }

  function dateStringFromParts(parts) {
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  }

  function browserTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }

  // Convert 9:00 AM on an Egg, Inc. Pacific event date into a real instant.
  // The small iteration handles PST/PDT without hard-coding UTC offsets.
  function eventInstantForDate(value) {
    const [year, month, day] = value.split('-').map(Number);
    const desiredAsUtc = Date.UTC(year, month - 1, day, EVENT_START_HOUR, 0, 0, 0);
    let guess = desiredAsUtc;
    for (let i = 0; i < 3; i += 1) {
      const observed = timeZoneParts(new Date(guess), MODEL_TIME_ZONE);
      const observedAsUtc = Date.UTC(
        observed.year, observed.month - 1, observed.day,
        observed.hour, observed.minute, observed.second, 0
      );
      guess += desiredAsUtc - observedAsUtc;
    }
    return new Date(guess);
  }

  function eventDateForInstant(date) {
    const parts = timeZoneParts(date, MODEL_TIME_ZONE);
    let value = dateStringFromParts(parts);
    if (parts.hour < EVENT_START_HOUR) value = addDays(value, -1);
    return value;
  }

  function eventDisplayDateIso(value, timeZone = browserTimeZone()) {
    return dateStringFromParts(timeZoneParts(eventInstantForDate(value), timeZone));
  }

  function fmtEventDate(value, options = { month: 'short', day: 'numeric', year: 'numeric' }, timeZone = browserTimeZone()) {
    return eventInstantForDate(value).toLocaleDateString(undefined, { ...options, timeZone });
  }

  function eventWeekdayShort(value, timeZone = browserTimeZone()) {
    return eventInstantForDate(value).toLocaleDateString(undefined, { weekday: 'short', timeZone });
  }

  function modelDateForDisplayDate(value, timeZone = browserTimeZone()) {
    for (let offset = -1; offset <= 1; offset += 1) {
      const candidate = addDays(value, offset);
      if (eventDisplayDateIso(candidate, timeZone) === value) return candidate;
    }
    return value;
  }

  function advanceForecastReference(currentReference, currentEventDate) {
    if (!currentEventDate) return currentReference || '';
    if (!currentReference || currentReference < currentEventDate) return currentEventDate;
    return currentReference;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function pct(value) {
    if (value < 0.005) return '<1%';
    return `${Math.round(value * 100)}%`;
  }

  function isAnniversaryDate(value) {
    return typeof value === 'string' && value.slice(5) === ANNIVERSARY_MM_DD;
  }

  function mulberry32(seed) {
    return function random() {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>\"]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
    }[character]));
  }

  root.EggEventLab.utils = {
    parseDate,
    isoDate,
    addDays,
    diffDays,
    fmtDate,
    weekdayShort,
    timeZoneParts,
    browserTimeZone,
    eventInstantForDate,
    eventDateForInstant,
    eventDisplayDateIso,
    fmtEventDate,
    eventWeekdayShort,
    modelDateForDisplayDate,
    advanceForecastReference,
    clamp,
    pct,
    isAnniversaryDate,
    mulberry32,
    hashString,
    escapeHtml
  };
})(typeof window !== 'undefined' ? window : globalThis);
