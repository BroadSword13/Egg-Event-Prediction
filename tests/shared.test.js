'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {update}=require('../scripts/update-shared.cjs');
const app=globalThis.EggEventLab;
const empty=()=>({predictions:{},observations:{},outcomes:{}});
const probs=Object.fromEntries(app.config.MODEL_ORDER.map(id=>[id,0])); probs.drone_green=1;
const predict=()=>probs;
function fixture() {
  const rows=[];
  for(let n=16;n<=22;n++) {
    const d=`2026-09-${n}`, weekday=new Date(d).getUTCDay();
    const type={0:'crafting-sale',1:'earnings-boost',5:'research-sale',6:'prestige-boost'}[weekday] || 'drone-boost';
    rows.push({id:d,type,startTimestamp:app.utils.eventInstantForDate(d).getTime()/1000,ultra:false,multiplier:4});
    if(n%2===0) rows.push({id:d+'u',type:'hab-sale',startTimestamp:app.utils.eventInstantForDate(d).getTime()/1000,ultra:true,multiplier:0.2});
  }
  return rows;
}
test('late and partial data remain pending; forecasts improve only before release',()=>{
  const rows=fixture();
  let s=update(empty(),rows,new Date('2026-09-23T12:00:00Z'),predict);
  assert.equal(s.predictions['2026-09-23'].status,'incomplete-history');
  assert.equal(s.outcomes['2026-09-22'].status,'pending');
  s=update(s,rows,new Date('2026-09-23T14:17:00Z'),predict);
  assert.equal(s.predictions['2026-09-23'].status,'eligible');
  assert.equal(s.outcomes['2026-09-22'].status,'complete');
  const frozen=structuredClone(s.predictions['2026-09-23']);
  const partial=rows.filter(r=>r.id!=='2026-09-22u');
  s=update(s,partial,new Date('2026-09-23T17:00:00Z'),predict);
  assert.deepEqual(s.predictions['2026-09-23'],frozen);
  assert.equal(s.outcomes['2026-09-22'].status,'pending');
  s=update(s,partial,new Date('2026-09-23T23:00:00Z'),predict);
  assert.equal(s.outcomes['2026-09-22'].status,'pending','missing expected Ultra must not become no-event');
});
test('late workflow never fabricates a pre-release forecast; finish cutoff and DST',()=>{
  const rows=fixture();
  let s=update(empty(),rows,new Date('2026-09-23T17:00:00Z'),predict);
  assert.equal(s.predictions['2026-09-23'],undefined);
  s=update(empty(),rows,new Date('2026-09-23T15:44:00Z'),predict,()=>new Date('2026-09-23T15:46:00Z'));
  assert.equal(s.predictions['2026-09-23'],undefined);
  assert.equal(app.utils.eventInstantForDate('2026-12-01').toISOString(),'2026-12-01T17:00:00.000Z');
  assert.equal(app.utils.eventInstantForDate('2026-09-23').toISOString(),'2026-09-23T16:00:00.000Z');
});
test('settled corrections update outcomes and scores but never probabilities',()=>{
  const rows=fixture();
  let s=update(empty(),rows,new Date('2026-09-23T11:00:00Z'),predict);
  s=update(s,rows,new Date('2026-09-23T14:00:00Z'),predict);
  const before=structuredClone(s.predictions);
  rows.push({id:'23',type:'drone-boost',ultra:false,startTimestamp:app.utils.eventInstantForDate('2026-09-23').getTime()/1000,multiplier:4});
  s=update(s,rows,new Date('2026-09-23T22:00:00Z'),predict);
  assert.equal(s.scores[90].overall.count,0);
  s=update(s,rows,new Date('2026-09-24T00:17:00Z'),predict);
  assert.equal(s.scores[90].nonUltra.score,100);
  rows[rows.length-1].type='vehicle-sale';
  s=update(s,rows,new Date('2026-09-24T01:17:00Z'),predict);
  assert.equal(s.scores[90].overall.count,0);
  s=update(s,rows,new Date('2026-09-24T03:17:00Z'),predict);
  assert.equal(s.scores[90].nonUltra.score,0);
  assert.deepEqual(s.predictions,before);
});
test('failed or regressed source does not mutate the archive',()=>{
  const s=empty();
  assert.throws(()=>update(s,[],new Date(),predict));
  assert.deepEqual(s,empty());
  assert.throws(()=>update({...s,sourceLatest:'2026-09-24'},fixture(),new Date('2026-09-23T12:00:00Z'),predict));
});
test('public score ignores browser overrides and retains labeled shared data on fetch failure',async()=>{
  require('../src/shared.js');
  app.clock.currentEventDate=()=> '2026-09-23';
  app.clock.now=()=>new Date('2026-09-23T23:00:00Z');
  const p={reference:'2026-09-22',savedAt:'2026-09-23T12:00:00Z',version:'0.6',status:'eligible',probabilities:probs};
  const value={schemaVersion:1,updatedAt:'2026-09-23T22:00:00Z',predictions:{'2026-09-23':p},outcomes:{'2026-09-23':{status:'complete',ids:['drone_green']}}};
  const original=global.fetch;
  try {
    global.fetch=async()=>({ok:true,json:async()=>value});
    await app.shared.refresh();
    assert.equal(app.shared.summary(90).nonUltra.score,100);
    app.store.getState().overrides['2026-09-23']=['shipping_blue'];
    assert.equal(app.shared.summary(90).nonUltra.score,100);
    global.fetch=async()=>{throw new Error('offline');};
    await app.shared.refresh();
    assert.equal(app.shared.summary(90).nonUltra.score,100);
    assert.match(app.shared.status(),/delayed/);
    value.predictions['2026-09-23'].status='incomplete-history';
    assert.equal(app.shared.summary(90).overall.count,0);
  } finally {global.fetch=original;}
});
