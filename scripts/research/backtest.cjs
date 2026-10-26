'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const e=require('./engine.cjs');
const rows=JSON.parse(fs.readFileSync(process.argv[2]||'data/shared/events.json'));
const periods={development:['2026-05-05','2026-07-31'],validation:['2026-08-01','2026-09-23'],recent:['2026-09-24','2026-10-26']};
const actual=e.app.wasmegg.normalizeWasmeggData(rows,'2026-10-26').confirmedDays;
const results=Object.fromEntries(Object.keys(e.VARIANTS).map(v=>[v,[]]));
for(let d='2026-05-05';d<='2026-10-26';d=e.app.utils.addDays(d,1)){
 if(e.EXCLUDED_DATES.includes(d)||d.endsWith('07-14')||!actual[d])continue;
 const prepared=e.prepare(rows,d);
 for(const v of Object.keys(results))results[v].push(...e.score(d,e.predictPrepared(prepared,v),actual[d]));
}
const report={generatedAt:new Date().toISOString(),sourceHash:crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'),excludedDates:e.EXCLUDED_DATES,periods,results:{}};
for(const [v,rr] of Object.entries(results))report.results[v]=Object.fromEntries(Object.entries(periods).map(([p,[a,b]])=>[p,e.summarize(rr.filter(r=>r.date>=a&&r.date<=b))]));
// Choose only on development. Validation is an acceptance gate, not a second tuning set.
const ranked=Object.keys(results).filter(v=>v!=='baseline').sort((a,b)=>report.results[b].development.overall.score-report.results[a].development.overall.score);
const best=ranked[0],b=report.results.baseline,c=report.results[best];
report.proposed=best;
report.accepted=c.development.overall.score>b.development.overall.score&&c.validation.overall.score>b.validation.overall.score&&['nonUltra','ultra'].every(t=>c.validation[t].score>=b.validation[t].score-1)?best:null;
report.pairedUncertainty={};
for(const [period,[a,b]] of Object.entries(periods)) {
  const baseline=results.baseline.filter(r=>r.date>=a&&r.date<=b);
  const candidate=results[best].filter(r=>r.date>=a&&r.date<=b);
  const blocks=new Map();
  for(const r of baseline){const c=candidate.find(x=>x.date===r.date&&x.tier===r.tier);if(c){const block=blocks.get(r.date)||[];block.push(100*(r.loss-c.loss));blocks.set(r.date,block);}}
  const days=[...blocks.values()],sample=[];let seed=123456789;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let k=0;k<5000;k++){let sum=0,count=0;for(let i=0;i<days.length;i++){const block=days[Math.floor(random()*days.length)];for(const v of block){sum+=v;count++;}}sample.push(sum/count);}
  sample.sort((a,b)=>a-b);
  report.pairedUncertainty[period]={gain:report.results[best][period].overall.score-report.results.baseline[period].overall.score,bootstrap95:[sample[125],sample[4874]],method:'Paired date-block bootstrap; descriptive, not adjusted for candidate selection'};
}
fs.mkdirSync('research',{recursive:true});fs.writeFileSync('research/backtest-results.json',JSON.stringify(report,null,2)+'\n');
for(const [v,p]of Object.entries(report.results))console.log(v,JSON.stringify(Object.fromEntries(Object.entries(p).map(([k,r])=>[k,{score:r.overall.score,N:r.nonUltra.score,U:r.ultra.score,count:r.overall.count}]))));
console.log('Selected on development:',report.proposed,'Accepted:',report.accepted);
