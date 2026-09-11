(function (root) {
  'use strict';

  const { MODEL_TIME_ZONE, EVENT_START_HOUR } = root.EggEventLab.config;
  const { eventDateForInstant } = root.EggEventLab.utils;

  let serverEpochMs = null;
  let monotonicAtSync = null;
  let source = 'browser';
  let lastSyncError = null;

  function monotonicNow() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
    return Date.now();
  }

  function now() {
    if (serverEpochMs != null && monotonicAtSync != null) {
      return new Date(serverEpochMs + (monotonicNow() - monotonicAtSync));
    }
    return new Date();
  }

  function currentEventDate() {
    return eventDateForInstant(now());
  }

  function status() {
    return {
      source,
      timeZone: MODEL_TIME_ZONE,
      eventStartHour: EVENT_START_HOUR,
      now: now().toISOString(),
      lastSyncError
    };
  }

  async function fetchServerDate() {
    if (typeof window === 'undefined' || !window.location || window.location.protocol === 'file:') {
      throw new Error('No HTTP server is available.');
    }

    const url = new URL(window.location.href);
    url.hash = '';
    url.searchParams.set('_clock', String(Date.now()));
    const response = await fetch(url.toString(), { method: 'HEAD', cache: 'no-store' });
    if (!response.ok) throw new Error(`Clock request returned HTTP ${response.status}.`);
    const header = response.headers.get('date');
    if (!header) throw new Error('Server did not provide a Date header.');
    const epoch = Date.parse(header);
    if (!Number.isFinite(epoch)) throw new Error('Server returned an invalid Date header.');
    return epoch;
  }

  async function sync() {
    try {
      serverEpochMs = await fetchServerDate();
      monotonicAtSync = monotonicNow();
      source = 'server';
      lastSyncError = null;
      return true;
    } catch (error) {
      serverEpochMs = null;
      monotonicAtSync = null;
      source = 'browser';
      lastSyncError = error?.message || String(error);
      return false;
    }
  }

  root.EggEventLab.clock = { now, currentEventDate, status, sync };
})(typeof window !== 'undefined' ? window : globalThis);
