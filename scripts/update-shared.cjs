'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
for (const f of ['src/config.js','data/seed-events.js','src/utils.js','src/clock.js','src/store.js','src/wasmegg.js','src/model.js','src/accuracy.js']) require(path.join(root,f));
const app = globalThis.EggEventLab;
const { addDays, eventDateForInstant, eventInstantForDate } = app.utils;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const HOUR = 3600000;
function update(previous, rows, now, predict, finishedAt = () => now) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Empty or invalid event history');
  const state = structuredClone(previous);
  state.predictions ||= {}; state.observations ||= {}; state.outcomes ||= {};
  if (previous.sourceCount && rows.length < previous.sourceCount * 0.9) throw new Error('Source history appears truncated');
  const today = eventDateForInstant(now), target = addDays(today, 1);
  const normalized = app.wasmegg.normalizeWasmeggData(rows, today);
  // An upstream truncation must not erase history or silently create false no-event days.
  if (previous.sourceLatest && normalized.latestDate < previous.sourceLatest) throw new Error('Source history regressed');
  const grouped = {};
  for (const r of rows) {
    const d = app.wasmegg.unixToIsoUTC(r.startTimestamp);
    if (d && d <= today) (grouped[d] ||= []).push(r);
  }
  const inputStore = app.store.createStore();
  Object.assign(inputStore.getState().remote, normalized, { syncedAt: now.toISOString() });
  inputStore.getState().overrides = {};
  inputStore.getState().settings = structuredClone(app.config.DEFAULT_SETTINGS);
  const inputModel = app.model.createModel(inputStore);
  const dates = new Set([...Object.keys(state.predictions).filter(d=>d<=today), ...Array.from({length:7},(_,i)=>addDays(today,-i))]);
  for (const d of dates) {
    const records = (grouped[d] || []).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const fingerprint = hash(records), old = state.observations[d];
    const unchanged = old?.fingerprint === fingerprint;
    const stableSince = unchanged ? old.stableSince : now.toISOString();
    const age = now - eventInstantForDate(d);
    const ids = normalized.confirmedDays[d] || [];
    const weekday = new Date(d+'T12:00:00Z').getUTCDay();
    const fixedTypes = {0:['crafting-sale','epic-research-sale'],1:['earnings-boost'],5:['research-sale'],6:['prestige-boost']};
    const regular = fixedTypes[weekday]
      ? records.some(r=>!r.ultra && fixedTypes[weekday].includes(r.type))
      : ids.some(id=>app.config.NON_ULTRA_MIDWEEK_POOL.has(id));
    const ultra = ids.some(id=>app.config.ULTRA_CADENCE_POOL.has(id));
    const modelForDay = app.model.createModel(app.store.createStore(structuredClone(inputStore.getState()), addDays(d,-1)));
    const expectedUltra = modelForDay.isUltraCadenceDate(d);
    const complete = records.length > 0 && regular && (!expectedUltra || ultra)
      && age >= 6*HOUR && unchanged && now - new Date(stableSince) >= 2*HOUR;
    state.observations[d] = { fingerprint, stableSince, checkedAt: now.toISOString() };
    state.outcomes[d] = { status: complete ? 'complete' : 'pending', ids: complete ? ids : [],
      reason: complete ? 'Stable source; expected tiers present' : !records.length ? 'Awaiting source data' : !regular || (expectedUltra && !ultra) ? 'Awaiting expected event tiers' : 'Waiting for source to settle', checkedAt: now.toISOString() };
  }
  const untilRelease = eventInstantForDate(target) - now;
  // Save in the last six hours, never in the final fifteen minutes or after release.
  if (untilRelease <= 6*HOUR && untilRelease > HOUR/4 && target.slice(5) !== '07-14') {
    const historyComplete = Array.from({length:7},(_,i)=>addDays(today,-i)).every(d=>d.slice(5)==='07-14' || state.outcomes[d]?.status === 'complete');
    const status = historyComplete ? 'eligible' : 'incomplete-history';
    const previousPrediction = state.predictions[target];
    // Keep the first eligible snapshot. A pending snapshot may improve only before release.
    if (previousPrediction?.status !== 'eligible') {
      const probabilities = (predict || ((reference)=>inputModel.simulateForecast(reference,1)[target]))(today);
      const ended = finishedAt();
      if (eventInstantForDate(target) - ended > HOUR/4 && eventDateForInstant(ended) === today) {
        state.predictions[target] = { reference: today, savedAt: ended.toISOString(), version: app.config.APP_VERSION,
          commit: process.env.GITHUB_SHA || null, status, sourceLatest: normalized.latestDate, inputHash: hash(rows),
          settings: structuredClone(app.config.DEFAULT_SETTINGS), probabilities };
      }
    }
  }
  state.schemaVersion = 1;
  state.updatedAt = now.toISOString(); state.sourceLatest = normalized.latestDate; state.sourceCount = rows.length;
  const eligible = Object.fromEntries(Object.entries(state.predictions).filter(([,v])=>v.status==='eligible'));
  const outcomes = Object.fromEntries(Object.entries(state.outcomes).filter(([,v])=>v.status==='complete').map(([d,v])=>[d,v.ids]));
  state.scores = Object.fromEntries([30,90,180].map(days=>[days,app.accuracy.summarize(days,{archive:eligible,confirmed:outcomes,today})]));
  return state;
}
async function main() {
  const folder = path.join(root,'data/shared');
  const filename = path.join(folder,'official.json');
  const previous = JSON.parse(fs.readFileSync(filename,'utf8'));
  const response = await fetch(app.config.WASMEGG_EVENTS_URL, { signal: AbortSignal.timeout(30000), cache:'no-store' });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  const rows = await response.json();
  const now = new Date();
  const state = update(previous,rows,now,null,()=>new Date());
  // Retain each forecast's exact input once; later source corrections remain auditable.
  fs.mkdirSync(path.join(folder,'inputs'),{recursive:true});
  for (const [date,p] of Object.entries(state.predictions)) {
    if (JSON.stringify(p) !== JSON.stringify(previous.predictions?.[date])) {
      fs.writeFileSync(path.join(folder,'inputs',`${date}.json.gz`),require('node:zlib').gzipSync(JSON.stringify(rows)));
    }
  }
  fs.writeFileSync(path.join(folder,'events.json'),JSON.stringify(rows));
  fs.writeFileSync(filename,JSON.stringify(state,null,2)+'\n');
  console.log(`Shared data refreshed; source through ${state.sourceLatest}`);
}
if (require.main === module) main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports = { update };
