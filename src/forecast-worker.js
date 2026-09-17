'use strict';
importScripts('config.js', '../data/seed-events.js', 'utils.js', 'store.js', 'model.js');
const jobs = new Map();
self.onmessage = event => {
  const { id, cancel, method, args, state } = event.data;
  if (cancel) { jobs.delete(id); return; }
  const app = self.EggEventLab;
  try {
    const isolatedStore = app.store.createStore(state);
    const iterator = app.model.createModel(isolatedStore).forecastSteps(method, args);
    jobs.set(id, iterator);
    function advance() {
      if (!jobs.has(id)) return;
      try {
        const until = performance.now() + 12;
        let result;
        do { result = iterator.next(); } while (!result.done && performance.now() < until);
        if (result.done) {
          jobs.delete(id);
          self.postMessage({ id, value: result.value });
        } else setTimeout(advance, 0);
      } catch (error) {
        jobs.delete(id);
        self.postMessage({ id, error: error.message });
      }
    }
    advance();
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
