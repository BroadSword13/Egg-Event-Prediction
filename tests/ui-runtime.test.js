'use strict';
// These are runtime/markup checks with a minimal DOM harness, not visual browser tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { Worker: NodeWorker } = require('node:worker_threads');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const elements = new Map();
function element() {
  return { value: '', hidden: false, checked: true, innerHTML: '', textContent: '', dataset: {}, style: {}, options: [],
    attributes: {}, handlers: {}, classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(event, fn) { this.handlers[event] = fn; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return []; }, appendChild() {}, scrollIntoView() {} };
}
for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], element());
global.window = globalThis;
global.document = { getElementById: id => elements.get(id) || null,
  querySelectorAll: () => [], createElement: element, body: element() };
for (const file of ['src/config.js','data/seed-events.js','src/utils.js','src/clock.js','src/store.js','src/model.js','src/accuracy.js','src/shared.js']) require(path.join(root,file));
const app = global.EggEventLab;
const workerInstances = [];
class WorkerHarness {
  constructor() {
    const script = `const {parentPort}=require('node:worker_threads');
      global.self=globalThis;
      global.postMessage=data=>parentPort.postMessage(data);
      global.importScripts=(...files)=>files.forEach(file=>require(require('node:path').resolve(${JSON.stringify(path.join(root,'src'))},file)));
      require(${JSON.stringify(path.join(root,'src/forecast-worker.js'))});
      parentPort.on('message',data=>global.onmessage({data}));`;
    this.worker = new NodeWorker(script,{eval:true});
    workerInstances.push(this.worker);
    this.worker.on('message',data=>this.onmessage?.({data}));
    this.worker.on('error',error=>this.onerror?.({message:error.message,preventDefault(){}}));
  }
  postMessage(data) { this.worker.postMessage(data); }
  terminate() { this.worker.terminate(); }
}
function loadService() { vm.runInThisContext(fs.readFileSync(path.join(root,'src/forecast-service.js'),'utf8')); }

test('worker, cooperative fallback, cancellation, and rendered date controls', async () => {
  global.Worker = WorkerHarness;
  loadService();
  const expected = app.model.simulateForecast('2026-09-14',3);
  let token = app.forecasts.begin('test');
  try {
    assert.deepEqual(await app.forecasts.run('simulateForecast',['2026-09-14',3],token), expected);
  } finally { app.forecasts.end(token); }
  assert.equal(elements.get('predictionStatus').hidden,true);

  const old = app.forecasts.begin('cancel');
  const abandoned = app.forecasts.run('simulateForecast',['2026-09-14',120],old);
  const rejected = assert.rejects(abandoned,{name:'AbortError'});
  const latest = app.forecasts.begin('cancel');
  app.forecasts.end(latest);
  await rejected;
  await Promise.all(workerInstances.map(worker=>worker.terminate()));

  global.Worker = class { constructor() { throw new Error('No worker support'); } };
  loadService();
  let ticks=0;
  const timer=setInterval(()=>ticks++,5);
  token=app.forecasts.begin('fallback');
  try {
    assert.deepEqual(await app.forecasts.run('simulateForecast',['2026-09-14',3],token),expected);
    assert.ok(ticks>1,'UI timers should run while computing');
  } finally { clearInterval(timer); app.forecasts.end(token); }

  elements.get('forecastStart').value='2026-09-14';
  elements.get('forecastDays').value=7;
  elements.get('capacityWeeks').value=4;
  require(path.join(root,'src/ui.js'));
  await app.ui.renderForecast();
  assert.match(elements.get('forecastTable').innerHTML,/forecast-gap-row/);
  assert.equal((elements.get('forecastTable').innerHTML.match(/class="date-cell"/g)||[]).length,7);
  assert.match(elements.get('nextLikelyCards').innerHTML,/likely-card/);

  app.store.getState().ui.calendarShowPredictions=false;
  await app.ui.renderCalendar();
  assert.match(elements.get('calendarGrid').innerHTML,/Scheduled/);
  if (app.utils.eventDisplayDateIso('2026-09-14') !== '2026-09-14') {
    assert.match(elements.get('calendarGrid').innerHTML,/schedule-zone/);
  }
  assert.match(elements.get('calendarPredictionNote').textContent,/not confirmed history/);
  app.store.getState().ui.calendarShowSchedule=false;
  await app.ui.renderCalendar();
  assert.doesNotMatch(elements.get('calendarGrid').innerHTML,/Scheduled/);

  assert.match(html,/id="currentEventDayBtn"/);
  assert.equal((html.match(/class="live-label"/g)||[]).length,2);
  assert.match(html,/id="saveDayBtn"[^>]*>Confirm<\/button>/);

  // Exercise actual handlers while keeping the clock deterministic.
  let currentDay = '2026-09-16';
  app.clock.currentEventDate = () => currentDay;
  app.store.getState().remote.autoSync = false;
  const realInterval = global.setInterval;
  let rollover;
  global.setInterval = fn => { rollover = fn; return 0; };
  try { app.ui.setup(); } finally { global.setInterval = realInterval; }
  const reference = elements.get('forecastStart');
  reference.value = '2026-09-10';
  reference.handlers.change();
  const liveDate = elements.get('todayEventDateBadge').textContent;
  assert.match(elements.get('referenceMode').textContent,/Selected reference day/);
  currentDay = '2026-09-17';
  await rollover();
  assert.equal(reference.value,'2026-09-10','rollover must not move a pinned reference');
  assert.notEqual(elements.get('todayEventDateBadge').textContent, liveDate);
  elements.get('currentEventDayBtn').handlers.click();
  assert.equal(reference.value,currentDay);
  assert.match(elements.get('referenceMode').textContent,/Following current event day/);
  const before = structuredClone(app.store.getState().overrides);
  elements.get('recordDate').value=app.utils.eventDisplayDateIso('2026-09-20');
  elements.get('saveDayBtn').handlers.click();
  assert.deepEqual(app.store.getState().overrides,before,'future confirmations must not be stored');
  assert.match(elements.get('validationMsg').textContent,/only after/);
  const deadline=Date.now()+30000;
  while (!elements.get('predictionStatus').hidden && Date.now()<deadline) {
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(elements.get('predictionStatus').hidden,true,'latest rendering should finish');

});
