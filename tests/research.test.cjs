'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const e=require('../scripts/research/engine.cjs'),{update}=require('../scripts/research/update-shadow.cjs');
const raw=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/shared/events.json')));
const probabilities=()=>Object.fromEntries(e.app.config.MODEL_ORDER.map(i=>[i,0]));
function official(now){return {updatedAt:now.toISOString(),sourceLatest:'2026-10-26',outcomes:Object.fromEntries(Array.from({length:7},(_,i)=>[e.app.utils.addDays('2026-10-26',-i),{status:'complete',ids:[]}]))};}
test('future rows do not influence any candidate; excluded outlier cannot shift the cadence',()=>{
 const target='2026-10-18';const truncated=raw.filter(r=>e.app.wasmegg.unixToIsoUTC(r.startTimestamp)<target);
 for(const v of Object.keys(e.VARIANTS))assert.deepEqual(e.predict(raw,target,v),e.predict(truncated,target,v));
 const p=e.predict(raw,target,'baseline');assert.ok([...e.app.config.ULTRA_CADENCE_POOL].reduce((s,i)=>s+p[i],0)>.9999);
 const noOutlier=raw.filter(r=>e.app.wasmegg.unixToIsoUTC(r.startTimestamp)!=='2026-10-17');
 assert.deepEqual(e.predict(raw,'2026-10-20','baseline'),e.predict(noOutlier,'2026-10-20','baseline'));
 assert.deepEqual(e.score('2026-10-17',probabilities(),['blocker_ultra_fueling']),[]);
});
test('all research variants preserve daily slot totals and hard restrictions',()=>{
 for(const d of ['2026-06-16','2026-09-27','2026-10-18','2026-10-22'])for(const v of Object.keys(e.VARIANTS)){
  const prepared=e.prepare(raw,d),p=e.predictPrepared(prepared,v);
  for(const i of e.app.config.MODEL_ORDER){assert.ok(p[i]>=0&&p[i]<=1);if(prepared.input.blocked[i])assert.equal(p[i],0);}
  for(const ids of [prepared.input.nonUltra,prepared.input.ultra])if(ids.length)assert.ok(Math.abs(ids.reduce((s,i)=>s+p[i],0)-1)<1e-10);
 }
});
test('exact baseline agrees with unmodified production sampling within sampling tolerance',()=>{
 const c=vm.createContext({console,structuredClone});const root=path.join(__dirname,'..');
 for(const f of ['src/config.js','data/seed-events.js','src/utils.js','src/store.js','src/wasmegg.js','src/model.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),c);
 const a=c.EggEventLab;const normalized=a.wasmegg.normalizeWasmeggData(raw.filter(r=>!e.EXCLUDED_DATES.includes(a.wasmegg.unixToIsoUTC(r.startTimestamp))),'2026-10-26');
 Object.assign(a.store.getState().remote,normalized,{syncedAt:'test'});
 for(const date of ['2026-10-14','2026-10-18']){
  const actual=a.model.simulateForecast(a.utils.addDays(date,-1),1)[date],expected=e.predict(raw,date,'baseline');
  for(const id of a.config.MODEL_ORDER)assert.ok(Math.abs(actual[id]-expected[id])<.035,`${date} ${id}: ${actual[id]} vs ${expected[id]}`);
 }
});
test('shadow archives only pre-release, freezes forecasts, and does not backfill',()=>{
 const now=new Date('2026-10-27T11:00:00Z'),o=official(now);
 const s=update({},raw,o,now);assert.equal(s.predictions['2026-10-27'].status,'eligible');assert.equal(s.reviewAfter,'2026-11-24');
 const changed=update(s,raw,o,now,()=>now,()=>{throw Error('Must not recalculate frozen forecast');});
 assert.deepEqual(changed.predictions,s.predictions);
 assert.equal(Object.keys(update({},raw,official(new Date('2026-10-27T16:01:00Z')),new Date('2026-10-27T16:01:00Z')).predictions).length,0);
 assert.equal(Object.keys(update({},raw,o,now,()=>new Date('2026-10-27T15:50:00Z')).predictions).length,0);
 assert.equal(Object.keys(update({},raw,{...o,updatedAt:'2026-10-26T11:00:00Z'},now).predictions).length,0);
 assert.throws(()=>update({...s,implementationHash:'wrong'},raw,o,now),/implementation changed/);
});
test('pending outcomes wait, corrections regrade paired scores without rewriting forecasts',()=>{
 const now=new Date('2026-10-27T11:00:00Z'),o=official(now),s=update({},raw,o,now);
 const later=new Date('2026-10-27T20:00:00Z');o.updatedAt=later.toISOString();o.outcomes['2026-10-27']={status:'pending',ids:[]};
 assert.equal(update(s,raw,o,later).scores.baseline.overall.count,0);
 o.outcomes['2026-10-27']={status:'complete',ids:['shipping_blue']};const graded=update(s,raw,o,later);
 assert.equal(graded.scores.baseline.overall.count,graded.scores.candidate.overall.count);assert.ok(graded.scores.baseline.overall.count>0);
 o.outcomes['2026-10-27'].ids=['blocker_gifts'];const corrected=update(graded,raw,o,later);
 assert.deepEqual(corrected.predictions,s.predictions);assert.notEqual(corrected.scores.baseline.overall.score,graded.scores.baseline.overall.score);
});
