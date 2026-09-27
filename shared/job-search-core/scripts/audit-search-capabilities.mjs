import {configureRuntime} from '../runtime-context.mjs';
import {pendingKeywordReviews,queueKeywordReviews} from './lib/source-keyword-maintenance.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
import {SOURCE_REGISTRY_FILE,SEARCH_CAPABILITIES_FILE} from '../registry.mjs';
import {directionSourceKey} from './lib/direction-validation.mjs';
import {nativeKeywordParameter} from './lib/targeted-search.mjs';
import {collectEndpoint} from './lib/source-collector.mjs';
import {keywordRequestProof,keywordNegativeComplete,keywordAuditCandidates} from './lib/keyword-audit-proof.mjs';
import {replayKeywordAudit} from './lib/keyword-audit-cache.mjs';
const arg=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
const registryFile=path.resolve(arg('registry')||SOURCE_REGISTRY_FILE),capabilitiesFile=path.resolve(arg('capabilities')||SEARCH_CAPABILITIES_FILE);
const readSourceRegistry=()=>fs.readFile(registryFile,'utf8').then(JSON.parse);
const maintenance=process.argv.includes('--maintenance'),checkOnly=process.argv.includes('--check');
if(checkOnly&&!maintenance)throw Error('--check requires --maintenance');
if(maintenance&&['pending','replay-only','scope-file','per-provider','providers'].some(k=>process.argv.some(a=>a==='--'+k||a.startsWith('--'+k+'='))))throw Error('Maintenance covers every pending configuration and mode; filters and replay-only are not allowed');
const pending=process.argv.includes('--pending'),dryRun=process.argv.includes('--dry-run'),replayOnly=process.argv.includes('--replay-only');
if(pending&&replayOnly)throw Error('--pending and --replay-only cannot be combined');
const deep=maintenance||process.argv.includes('--deep');
const providers=arg('providers')?new Set(arg('providers').split(',')):null;
const out=path.resolve(arg('out')||'shared/job-search-core/state/maintenance/search-capabilities-'+new Date().toISOString().slice(0,10).replaceAll('-',''));
const save=async(p,v)=>{await fs.mkdir(path.dirname(p),{recursive:true});const temporary=p+'.'+process.pid+'.'+Math.random().toString(16).slice(2)+'.tmp';try{await fs.writeFile(temporary,JSON.stringify(v,null,2)+'\n');await fs.rename(temporary,p);}finally{await fs.rm(temporary,{force:true});}};
const exists=async p=>{try{await fs.access(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const read=async(p,d)=>{try{return JSON.parse(await fs.readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return d;throw e;}};
if(!isMainThread){
 configureRuntime({mode:workerData.mode,repairPolicy:'off'});
 const originalFetch=globalThis.fetch;parentPort.on('message',async task=>{
  const signal=AbortSignal.timeout(deep?180000:45000);let requests=0;globalThis.fetch=(u,o={})=>{if(++requests>(deep?240:45))throw Error('keyword_audit_budget');return originalFetch(u,{...o,signal:o.signal?AbortSignal.any([signal,o.signal]):signal});};
  try{const directionDiscoveryMemo=new Map(),requestBudget={remaining:deep?240:45};const query=async(keyword,name)=>{const r=await collectEndpoint(task.source,{targetMode:task.mode,mode:'list',maxPages:deep&&name.startsWith('positive')?5:1,maxDetails:0,pageSize:20,timeoutMs:deep?20000:8000,signal,requestBudget,directionDiscoveryMemo,keyword,repair:false,refresh:deep,evidenceDir:path.join(task.folder,name,'http')});await save(path.join(task.folder,name+'.json'),r);const blocked=(r.requests||[]).find(q=>[401,403,429].includes(q.http_status));if(blocked)throw Error(blocked.http_status===429?'rate_limited_stop_current_probe':'access_restricted_stop_current_probe');return r;};
   const baseline=await query('','baseline');if(!baseline.jobs.length){parentPort.postMessage({status:'parameter_candidate',reason:'baseline_empty_or_unavailable',requests});return;}
   const sample=baseline.jobs.find(j=>typeof j.title==='string'&&j.title.trim()&&j.job_id!=null&&String(j.job_id));if(!sample)throw Error('no_sample_title');
   let keyword=keywordAuditCandidates(sample.title)[0],positive=await query(keyword,'positive');
   if(deep&&!positive.jobs.some(j=>String(j.job_id)===String(sample.job_id))){
    for(const [i,candidate] of keywordAuditCandidates(sample.title).slice(1).entries()){
     const result=await query(candidate,'positive-alternative-'+i);
     if(result.jobs.some(j=>String(j.job_id)===String(sample.job_id))){keyword=candidate;positive=result;await save(path.join(task.folder,'positive.json'),positive);break;}
    }
   }
   const negative='zzNoRecruitmentMatch_'+task.key.slice(0,16),absent=await query(negative,'negative');
   const positiveMatch=positive.jobs.some(j=>String(j.job_id)===String(sample.job_id)),negativeEmpty=keywordNegativeComplete(task.source.provider,absent);
   const requestProof=keywordRequestProof(task.source.provider,baseline,positive,absent,keyword,negative);
   const proof={baseline_job_id:sample.job_id,positive_keyword:keyword,positive_match:positiveMatch,positive_count:positive.jobs.length,negative_keyword:negative,negative_count:absent.jobs.length,negative_complete:negativeEmpty,scope_limitation:absent.coverage?.direction?.limitation||null,...requestProof};
   const verified=positiveMatch&&negativeEmpty&&requestProof.keyword_sent&&requestProof.same_list_routes;
   parentPort.postMessage({status:verified?'verified_native_keyword':'parameter_candidate',reason:verified?'positive_id_retained_and_unique_negative_returns_empty':'filter_not_proven',proof,requests});
  }catch(e){parentPort.postMessage({status:'parameter_candidate',reason:e.message,requests});}
 });
}else{
 const registrySnapshot=await readSourceRegistry(),companies=registrySnapshot.companies,rows=[],tasks=[],counts=new Map(),perProvider=Number(arg('per-provider')||((maintenance||pending||replayOnly)?Infinity:10)),concurrency=Number(arg('concurrency')||4);
 if(!(perProvider>0)||!Number.isInteger(concurrency)||concurrency<1||concurrency>16)throw Error('Invalid per-provider or concurrency (1–16)');
 let scope=arg('scope-file')?new Set((await read(path.resolve(arg('scope-file')))).map(r=>typeof r==='string'?r:r.key+'|'+r.mode)):null;
 const previous=await read(capabilitiesFile,{configurations:[]}),byKey=new Map(previous.configurations.map(r=>[r.key+'|'+r.mode,r]));
 if(arg('register-before')){if(!maintenance||dryRun||checkOnly)throw Error('--register-before requires an executing --maintenance run');await queueKeywordReviews(await read(path.resolve(arg('register-before'))),registrySnapshot,{registryFile});}
 const maintenanceScope=maintenance?await pendingKeywordReviews(registrySnapshot,previous,{registryFile}):[];
 if(maintenance)scope=new Set(maintenanceScope.map(r=>r.key+'|'+r.mode));
 const classified=[],unsupported=new Map();
 if(arg('unsupported-review')){
  if(!maintenance)throw Error('Unsupported contract reviews require --maintenance');
  for(const review of await read(path.resolve(arg('unsupported-review')))){
   if(!scope.has(review.key+'|'+review.mode)||review.finding!=='official_contract_explicitly_disallows_keyword'||!/^https?:\/\//.test(review.evidence_url||'')||!review.reason?.trim()||!review.reviewed_at||!review.evidence_file)throw Error('Unsupported review requires current scope, explicit official contract finding, reason, date and saved evidence');
   if(!(await fs.readFile(path.resolve(review.evidence_file),'utf8')).trim())throw Error('Empty unsupported evidence');
   unsupported.set(review.key+'|'+review.mode,{finding:review.finding,evidence_url:review.evidence_url,reviewed_at:review.reviewed_at,reason:review.reason});
  }
 }
 for(const c of companies)for(const [index,s] of (c.recruitment_sources?.length?c.recruitment_sources:[c]).entries())for(const mode of ['campus','internship','social']){
  const key=directionSourceKey(c,s,index),parameter=nativeKeywordParameter(s.provider),row=byKey.get(key+'|'+mode)||{key,company_id:c.company_id,provider:s.provider,source_id:s.source_id||String(index),mode,status:parameter?'parameter_candidate':'local_title_filter',parameter,reason:parameter?'awaiting_per_configuration_live_proof':'no_confirmed_native_keyword_adapter',fallback:'list_and_local_title_filter'};rows.push(row);
  if(maintenance&&scope.has(key+'|'+mode)&&(!parameter||unsupported.has(key+'|'+mode))){const contract=unsupported.get(key+'|'+mode);Object.assign(row,{status:'local_title_filter',proof:null,support_status:contract?'unsupported':'unconfirmed',reason:contract?.reason||'no_confirmed_native_keyword_adapter',maintenance_checked_at:new Date().toISOString(),...(contract?{contract_review:contract}:{})});classified.push(row);}
  row.parameter=parameter;if(parameter&&!unsupported.has(key+'|'+mode)&&row.support_status!=='unsupported'&&row.status==='local_title_filter'){row.status='parameter_candidate';row.reason='awaiting_per_configuration_live_proof';}
  const group=s.provider+'|'+mode,folder=path.join(out,key,mode);if(parameter&&!unsupported.has(key+'|'+mode)&&(!scope||scope.has(key+'|'+mode))&&(!providers||providers.has(s.provider))&&(!pending||row.status!=='verified_native_keyword')&&(counts.get(group)||0)<perProvider&&(!replayOnly||await exists(path.join(folder,'proof.json')))){counts.set(group,(counts.get(group)||0)+1);tasks.push({key,mode,source:{...s,company_id:c.company_id,display_name:c.display_name},folder,row});}
 }
 let next=0,completed=0;const stats=()=>({planned:tasks.length,completed,maintenance_required:maintenanceScope.length,classified_without_adapter:classified.length,total_direction_configurations:rows.length,verified:rows.filter(r=>r.status==='verified_native_keyword').length,no_native_adapter:rows.filter(r=>!nativeKeywordParameter(r.provider)).length,groups:Object.fromEntries(counts),updated_at:new Date().toISOString()});
 console.log(JSON.stringify(stats()));if(dryRun||checkOnly)process.exit(checkOnly&&maintenanceScope.length?2:0);
 await fs.mkdir(out,{recursive:true});try{await fs.writeFile(path.join(out,'previous-capabilities.json'),JSON.stringify(previous,null,2)+'\n',{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
 const publish=!process.argv.includes('--no-publish'),lockFile=capabilitiesFile+'.audit.lock';
 let auditLock;if(publish){await fs.mkdir(path.dirname(capabilitiesFile),{recursive:true});try{auditLock=await fs.open(lockFile,'wx');}catch(e){if(e.code==='EEXIST')throw Error('Another keyword audit is publishing; retry after it finishes');throw e;}}
 const timer=setInterval(()=>console.log(JSON.stringify(stats())),30000);
 async function slot(){let worker,workerMode;while(next<tasks.length){const task=tasks[next++];let proof=await read(path.join(task.folder,'proof.json'),null);if(proof){proof=await replayKeywordAudit({folder:task.folder,provider:task.source.provider,key:task.key},proof);await save(path.join(task.folder,'proof.json'),proof);}else if(replayOnly){throw Error('Replay evidence disappeared: '+task.folder);}else{if(worker&&workerMode!==task.mode){await worker.terminate();worker=null;}workerMode=task.mode;worker||=new Worker(fileURLToPath(import.meta.url),{argv:deep?['--deep']:[],workerData:{mode:task.mode}});proof=await new Promise(resolve=>{const cleanup=()=>{clearTimeout(deadline);worker?.removeAllListeners('message');worker?.removeAllListeners('error');};const fail=async e=>{cleanup();await worker?.terminate();worker=null;resolve({status:'parameter_candidate',reason:String(e)});};const deadline=setTimeout(()=>fail('audit_deadline'),deep?190000:47000);worker.once('error',fail);worker.once('message',r=>{cleanup();resolve(r);});worker.postMessage(task);});proof.checked_at=new Date().toISOString();await save(path.join(task.folder,'proof.json'),proof);}Object.assign(task.row,{proof:null},proof,{evidence_file:path.relative(path.resolve('shared/job-search-core'),path.join(task.folder,'proof.json')).replaceAll('\\','/')});if(maintenance||task.row.maintenance_checked_at)Object.assign(task.row,{support_status:task.row.status==='verified_native_keyword'?'supported':'unconfirmed',maintenance_checked_at:new Date().toISOString()});completed++;}await worker?.terminate();}
 try{await Promise.all(Array.from({length:concurrency},slot));if(maintenance)await save(path.join(out,'maintenance-results.json'),rows.filter(r=>scope.has(r.key+'|'+r.mode)));if(JSON.stringify(await readSourceRegistry())!==JSON.stringify(registrySnapshot))throw Error('Registry changed during keyword audit; results saved privately, rerun for current configurations');if(publish&&JSON.stringify(await read(capabilitiesFile,{configurations:[]}))!==JSON.stringify(previous))throw Error('Capabilities changed during audit; rerun to avoid overwriting another audit');if(publish)await save(capabilitiesFile,{schema_version:1,policy:'native_only_after_positive_and_negative_controls; all_other_sources_use_local_title_filter',checked_at:new Date().toISOString(),configurations:rows});await save(path.join(out,'summary.json'),stats());console.log(JSON.stringify(stats()));}finally{clearInterval(timer);if(auditLock){await auditLock.close();await fs.unlink(lockFile);}}
}
