(function (root) {
  'use strict';
  const app = root.EggEventLab;
  const channels = new Map();
  const pending = new Map();
  const cache = new Map();
  let worker = null;
  let workerFailed = false;
  let sequence = 0;

  function abortError() { return new DOMException('Forecast superseded', 'AbortError'); }
  function updateStatus() {
    const busy = [...channels.values()].some(token => !token.done);
    const status = document.getElementById('predictionStatus');
    if (status) { status.hidden = !busy; status.textContent = 'Updating predictions…'; }
    document.getElementById('forecastTable')?.setAttribute('aria-busy', String(busy));
  }
  function begin(channel) {
    const previous = channels.get(channel);
    if (previous) { previous.aborted = true; previous.cancel.forEach(fn => fn()); }
    const token = { aborted: false, done: false, cancel: [] };
    channels.set(channel, token);
    updateStatus();
    return token;
  }
  function end(token) { token.done = true; updateStatus(); }
  function getWorker() {
    if (worker || workerFailed) return worker;
    try {
      worker = new Worker('src/forecast-worker.js');
      worker.onmessage = ({ data }) => {
        const job = pending.get(data.id);
        if (!job) return;
        pending.delete(data.id);
        if (data.error) job.reject(new Error(data.error)); else job.resolve(data.value);
      };
      worker.onerror = event => {
        event.preventDefault();
        workerFailed = true;
        worker.terminate();
        worker = null;
        for (const job of pending.values()) job.fallback();
        pending.clear();
      };
    } catch { workerFailed = true; worker = null; }
    return worker;
  }
  function run(method, args, token) {
    if (token.aborted) return Promise.reject(abortError());
    const state = app.store.clone(app.store.getState());
    const snapshot = app.store.createStore(state, args[0]);
    const key = JSON.stringify([method, args, state.settings,
      app.config.MODEL_ORDER.map(id => snapshot.modelDates(id))]);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const complete = value => {
        if (token.aborted) { reject(abortError()); return; }
        cache.set(key, value);
        if (cache.size > 20) cache.delete(cache.keys().next().value);
        resolve(value);
      };
      const fallback = () => {
        if (token.aborted) { reject(abortError()); return; }
        const iterator = app.model.createModel(snapshot).forecastSteps(method, args);
        function advance() {
          if (token.aborted) { reject(abortError()); return; }
          try {
            const until = performance.now() + 12;
            let result;
            do { result = iterator.next(); } while (!result.done && performance.now() < until);
            if (result.done) complete(result.value); else setTimeout(advance, 0);
          } catch (error) { reject(error); }
        }
        setTimeout(advance, 0);
      };
      token.cancel.push(() => {
        pending.delete(id);
        worker?.postMessage({ id, cancel: true });
        reject(abortError());
      });
      const activeWorker = getWorker();
      if (activeWorker) {
        pending.set(id, { resolve: complete, reject, fallback });
        activeWorker.postMessage({ id, method, args, state });
      } else fallback();
    });
  }
  app.forecasts = { begin, end, run };
})(window);
