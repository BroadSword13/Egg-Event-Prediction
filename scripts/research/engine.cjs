'use strict';
// Research-only adapter: public browser scripts and forecasts are never modified.
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const root = path.resolve(__dirname,'../..');
const context = vm.createContext({console, structuredClone});
for (const f of ['src/config.js','data/seed-events.js','src/utils.js','src/store.js','src/wasmegg.js'])
  vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),context);
let source = fs.readFileSync(path.join(root,'src/model.js'),'utf8');
const marker = '  return {\n    createModel,';
if (source.split(marker).length !== 2) throw new Error('Research adapter must be reviewed after model structure changes');
source = source.replace(marker,`  function researchInputs(date) {
    const stats={}, last={}, weights={}, blocked={};
    MODEL_ORDER.forEach(id=>{
      stats[id]=buildStatCache(id,date); last[id]=store.lastEventBefore(id,date);
      weights[id]=hazardFast(id,date,last[id],stats[id]); blocked[id]=isHardBlocked(id,date,last[id]);
    });
    return {stats,last,weights,blocked,nonUltra:nonUltraCandidatesForDate(date),ultra:ultraCandidatesForDate(date)};
  }
  return {
    researchInputs,
    createModel,`);
vm.runInContext(source,context);
const app=context.EggEventLab, config=app.config, {addDays,diffDays}=app.utils;
const EXCLUDED_DATES=['2026-10-17'];
const VARIANTS={
  baseline:{}, frequencyN50:{blendN:.5}, frequencyU50:{blendU:.5},
  frequencyBoth50:{blendN:.5,blendU:.5}, smoothN:{smoothN:true},
  smoothU:{smoothU:true}, recentU:{recentU:true}
};
function prepare(rows,date) {
  const cutoff=addDays(date,-1);
  const filtered=rows.filter(r=>!EXCLUDED_DATES.includes(app.wasmegg.unixToIsoUTC(r.startTimestamp)));
  const normalized=app.wasmegg.normalizeWasmeggData(filtered,cutoff);
  const store=app.store.createStore();
  Object.assign(store.getState().remote,normalized,{syncedAt:'research'});
  const scoped=app.store.createStore(structuredClone(store.getState()),cutoff);
  const model=app.model.createModel(scoped,true);
  return {store:scoped,input:model.researchInputs(date),date};
}
function hazardFromRows(rows,gap,fraction) {
  const support=rows.reduce((s,r)=>s+r.weighted,0);
  const mean=support?rows.reduce((s,r)=>s+r.gap*r.weighted,0)/support:14;
  const prior=1/Math.max(2,mean*fraction),max=rows.length?Math.max(...rows.map(r=>r.gap)):0;
  if(gap===null)return prior;
  const exact=rows.filter(r=>r.gap===gap).reduce((s,r)=>s+r.weighted,0);
  const survivor=rows.filter(r=>r.gap>=gap).reduce((s,r)=>s+r.weighted,0);
  const tail=rows.filter(r=>r.gap===max).reduce((s,r)=>s+r.weighted,0);
  return Math.min(.95,gap>max?1-(1-(tail+3*prior)/(tail+3))*Math.exp(-(gap-max)/mean):(exact+3*prior)/(survivor+3));
}
function normalize(weights,ids) {
  const total=ids.reduce((s,i)=>s+(weights[i]||0),0);
  return Object.fromEntries(ids.map(i=>[i,total?(weights[i]||0)/total:1/ids.length]));
}
function predictPrepared(prepared,variant='baseline') {
  const opt=VARIANTS[variant]; if(!opt)throw new Error('Unknown research model');
  const {input,store,date}=prepared, weights={...input.weights};
  for(const id of config.MODEL_ORDER) {
    if(input.blocked[id] || config.EVENTS[id].sundayOnly)continue;
    const ultra=config.EVENTS[id].tier==='ultra',smooth=ultra?opt.smoothU:opt.smoothN;
    let rows=input.stats[id].rows;
    if(ultra&&opt.recentU){
      const grouped=new Map();
      for(const r of store.historicalGaps(id,date))if(r.endDate>='2026-05-04')grouped.set(r.gap,(grouped.get(r.gap)||0)+store.recencyWeight(r.endDate,date));
      rows=[...grouped].map(([gap,weighted])=>({gap,weighted}));
    }
    if(smooth){
      // Fixed triangular kernel, not fitted to the evaluation outcomes.
      const spread=new Map(),step=ultra?2:1,min=config.EVENTS[id].minGap||1;
      for(const row of rows){
        const points=[[-step,.25],[0,.5],[step,.25]].filter(([delta])=>row.gap+delta>=min);
        const mass=points.reduce((s,[,w])=>s+w,0);
        for(const [delta,w] of points)spread.set(row.gap+delta,(spread.get(row.gap+delta)||0)+row.weighted*w/mass);
      }
      rows=[...spread].map(([gap,weighted])=>({gap,weighted}));
    }
    if(smooth||(ultra&&opt.recentU))weights[id]=hazardFromRows(rows,input.last[id]?diffDays(input.last[id],date):null,ultra?.5:3/7);
  }
  const n=input.nonUltra.filter(i=>!input.blocked[i]),u=input.ultra.filter(i=>!input.blocked[i]);
  for(const [ids,mix] of [[n,opt.blendN||0],[u,opt.blendU||0]])if(mix&&ids.length){
    const gap=normalize(weights,ids),freq={};
    ids.forEach(i=>freq[i]=1+store.modelDates(i).filter(d=>d<date&&diffDays(d,date)<=180).length);
    const base=normalize(freq,ids);ids.forEach(i=>weights[i]=(1-mix)*gap[i]+mix*base[i]);
  }
  const out=Object.fromEntries(config.MODEL_ORDER.map(i=>[i,0]));
  if(n.length&&u.length){
    const nw=normalize(weights,n),uw=normalize(weights,u);let total=0;
    for(const i of n)for(const j of u)if(config.EVENTS[i].family!==config.EVENTS[j].family){const w=nw[i]*uw[j];total+=w;out[i]+=w;out[j]+=w;}
    if(!total)throw new Error('No compatible research outcomes');
    for(const i of [...n,...u])out[i]/=total;
  }else for(const ids of [n,u])Object.assign(out,normalize(weights,ids));
  // Optional Non-Ultra capacity is suppressed when the Ultra capacity slot wins.
  out.capacity_purple=input.weights.capacity_purple*(1-out.capacity_pink);
  return out;
}
function predict(rows,date,variant){return predictPrepared(prepare(rows,date),variant);}
function score(date,probabilities,actual){
  if(EXCLUDED_DATES.includes(date)||date.slice(5)==='07-14')return [];
  const result=[];
  for(const [tier,ids] of [['nonUltra',[...config.NON_ULTRA_MIDWEEK_POOL]],['ultra',[...config.ULTRA_CADENCE_POOL]]]){
    if(tier==='nonUltra'&&![2,3,4].includes(new Date(date+'T12:00Z').getUTCDay()))continue;
    const hits=ids.filter(i=>actual.includes(i)),sum=ids.reduce((s,i)=>s+probabilities[i],0);
    if(hits.length>1)continue;
    if(!hits.length&&sum<1e-9)continue;
    const ps=[...ids.map(i=>probabilities[i]),Math.max(0,1-sum)];const target=hits.length?ids.indexOf(hits[0]):ids.length;
    const ranked=ps.map((p,i)=>({p,i})).sort((a,b)=>b.p-a.p);
    result.push({date,tier,loss:ps.reduce((s,p,i)=>s+(p-Number(i===target))**2,0)/2,top:ranked[0].i===target,top3:ranked.slice(0,3).some(r=>r.i===target)});
  }return result;
}
function summarize(rows){
 const stats=rr=>({count:rr.length,score:rr.length?100*(1-rr.reduce((s,r)=>s+r.loss,0)/rr.length):null,top:rr.filter(r=>r.top).length,top3:rr.filter(r=>r.top3).length});
 return {overall:stats(rows),nonUltra:stats(rows.filter(r=>r.tier==='nonUltra')),ultra:stats(rows.filter(r=>r.tier==='ultra'))};
}
module.exports={prepare,predictPrepared,predict,score,summarize,VARIANTS,EXCLUDED_DATES,app};
