'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const engine=require('./engine.cjs');
const root=path.resolve(__dirname,'../..');
const ID='frequency-blend-50-v1';
const CANDIDATE='frequencyBoth50';
const HOUR=3600000;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
// Freeze the implementation as well as the settings. A code change needs a new study ID.
function implementationHash(){return hash(['scripts/research/engine.cjs','src/model.js','src/store.js','src/config.js','src/wasmegg.js','src/utils.js','data/seed-events.js'].map(f=>f+'\n'+fs.readFileSync(path.join(root,f),'utf8')).join('\n'));}
function update(previous,rows,official,now,finishedAt=()=>now,predictor=null){
 if(!Array.isArray(rows)||!rows.length)throw new Error('Missing shared event history');
 const state=structuredClone(previous||{}),revision=implementationHash();
 if(state.experimentId&&(state.experimentId!==ID||state.implementationHash!==revision))throw new Error('Study implementation changed; start a new study ID/file instead of mixing revisions');
 const {addDays,eventDateForInstant,eventInstantForDate}=engine.app.utils;
 const today=eventDateForInstant(now),target=addDays(today,1);
 const inputHash=hash(JSON.stringify(rows));
 state.schemaVersion=1;state.experimentId=ID;state.implementationHash=revision;
 state.candidate=CANDIDATE;state.excludedDates=engine.EXCLUDED_DATES;
 state.predictions||={};
 const remaining=eventInstantForDate(target)-now;
 const officialAge=now-new Date(official.updatedAt);
 const fresh=Number.isFinite(officialAge)&&officialAge>=0&&officialAge<=HOUR/2;
 const observed=engine.app.wasmegg.normalizeWasmeggData(rows,today).latestDate;
 const complete=Array.from({length:7},(_,i)=>addDays(today,-i)).every(d=>engine.EXCLUDED_DATES.includes(d)||d.endsWith('07-14')||official.outcomes?.[d]?.status==='complete');
 // No retrospective predictions, even when a workflow was missed.
 if(remaining<=6*HOUR&&remaining>HOUR/4&&!engine.EXCLUDED_DATES.includes(target)&&!target.endsWith('07-14')&&state.predictions[target]?.status!=='eligible'&&fresh&&observed===official.sourceLatest){
   const prepared=engine.prepare(rows,target);
   const predictions=predictor?predictor(target):{
     baseline:engine.predictPrepared(prepared,'baseline'),candidate:engine.predictPrepared(prepared,CANDIDATE)
   };
   for(const name of ['baseline','candidate'])for(const id of engine.app.config.MODEL_ORDER){
     const p=predictions[name]?.[id];if(!Number.isFinite(p)||p<0||p>1)throw new Error('Invalid shadow probability');
   }
   const ended=finishedAt();
   if(eventDateForInstant(ended)===today&&eventInstantForDate(target)-ended>HOUR/4){
     const publicSnapshot=official.predictions?.[target];
     state.predictions[target]={reference:today,savedAt:ended.toISOString(),status:complete?'eligible':'incomplete-history',
       inputHash,sourceLatest:observed,implementationHash:revision,commit:process.env.GITHUB_SHA||null,
       baseline:predictions.baseline,candidate:predictions.candidate,
       publicForecast:publicSnapshot?.status==='eligible'&&publicSnapshot.inputHash===inputHash?structuredClone(publicSnapshot.probabilities):null};
   }
 }
 const paired={baseline:[],candidate:[]};
 const pairedDates=[];
 for(const [date,p]of Object.entries(state.predictions)){
   if(date>today||p.status!=='eligible'||engine.EXCLUDED_DATES.includes(date)||official.outcomes?.[date]?.status!=='complete')continue;
   const actual=official.outcomes[date].ids;
   const baseline=engine.score(date,p.baseline,actual),candidate=engine.score(date,p.candidate,actual);
   // Score exactly the same date/tier outcomes on both sides.
   for(const b of baseline){const c=candidate.find(r=>r.tier===b.tier);if(c){paired.baseline.push(b);paired.candidate.push(c);}}
   pairedDates.push(date);
 }
 state.updatedAt=now.toISOString();state.scores={baseline:engine.summarize(paired.baseline),candidate:engine.summarize(paired.candidate)};
 const first=Object.keys(state.predictions).filter(d=>state.predictions[d].status==='eligible').sort()[0]||null;
 state.firstForecastDate=first;state.reviewAfter=first?addDays(first,28):null;
 state.scoredDates=pairedDates.sort();state.status=!first?'Waiting for first pre-release snapshot':now<eventInstantForDate(state.reviewAfter)?'Collecting four weeks of paired forecasts':'Ready for review; no automatic promotion';
 return state;
}
function main(){
 const folder=path.join(root,'data/shared'),file=path.join(folder,'shadow.json');
 const rows=JSON.parse(fs.readFileSync(path.join(folder,'events.json'),'utf8'));
 const official=JSON.parse(fs.readFileSync(path.join(folder,'official.json'),'utf8'));
 const previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
 const state=update(previous,rows,official,new Date(),()=>new Date());
 fs.mkdirSync(path.join(folder,'shadow-inputs'),{recursive:true});
 for(const [date,p]of Object.entries(state.predictions))if(JSON.stringify(p)!==JSON.stringify(previous.predictions?.[date]))
   fs.writeFileSync(path.join(folder,'shadow-inputs',`${date}.json.gz`),zlib.gzipSync(JSON.stringify(rows)));
 const temporary=file+'.tmp';fs.writeFileSync(temporary,JSON.stringify(state,null,2)+'\n');fs.renameSync(temporary,file);
 console.log(`${ID}: ${state.status}; ${state.scoredDates.length} settled dates`);
}
if(require.main===module)try{main();}catch(error){console.error(error);process.exitCode=1;}
module.exports={update,implementationHash};
