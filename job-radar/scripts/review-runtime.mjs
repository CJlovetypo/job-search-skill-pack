import {createHash,randomUUID} from 'node:crypto';
import {radarQuery,configIssues,radarSelection,radarSearchPlan} from './query.mjs';
import {relevanceRequest,relevanceKey,validateRelevance} from '../../shared/job-search-core/scripts/lib/role-relevance.mjs';
import {sourceConfigFingerprint} from '../../shared/job-search-core/scripts/lib/source-collector.mjs';
const json=JSON.stringify;
const hash=x=>createHash('sha256').update(json(x)).digest('hex');
export function initializeReviewTables(db,{rebuildIndex=false}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS run_context(run TEXT PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS staged_results(run TEXT,company TEXT,payload TEXT NOT NULL,PRIMARY KEY(run,company));
 CREATE TABLE IF NOT EXISTS relevance_reviews(key TEXT PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS review_requests(run TEXT,key TEXT,payload TEXT NOT NULL,PRIMARY KEY(run,key));
 CREATE TABLE IF NOT EXISTS migration_state(subscription TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
 if(rebuildIndex)db.exec('DROP INDEX IF EXISTS one_running');
 db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_running ON runs(subscription) WHERE status IN ('running','awaiting_review','finalizing');");
}
export function pendingReviews(db,run){
 if(!db.prepare("SELECT name FROM sqlite_master WHERE name='review_requests'").get())return [];
 return db.prepare('SELECT q.key,q.payload FROM review_requests q LEFT JOIN relevance_reviews r ON q.key=r.key WHERE q.run=? AND r.key IS NULL').all(run).map(x=>({key:x.key,...JSON.parse(x.payload)}));
}
export function submitReviews(db,run,items){
 const state=db.prepare('SELECT status FROM runs WHERE id=?').get(run);if(!state||!['running','awaiting_review'].includes(state.status))throw Error('运行不在等待审阅阶段');
 if(!Array.isArray(items)||!items.length)throw Error('需要非空相关性判断列表');
 const submitted=new Map();
 const allowed=new Map(db.prepare('SELECT key,payload FROM review_requests WHERE run=?').all(run).map(r=>[r.key,JSON.parse(r.payload)])),validated=[];
 for(const item of items){const key=relevanceKey(item),request=allowed.get(key);if(!request)throw Error('岗位不属于本轮相关性待办');const value=validateRelevance(item,request),old=db.prepare('SELECT payload FROM relevance_reviews WHERE key=?').get(key);if(submitted.has(key)&&submitted.get(key)!==json(value))throw Error('批次内重复提交的相关性判断冲突');submitted.set(key,json(value));if(old&&old.payload!==json(value))throw Error('重复提交的相关性判断冲突');validated.push([key,json(value)]);}
 db.exec('BEGIN IMMEDIATE');try{for(const [key,value]of validated){const current=db.prepare('SELECT payload FROM relevance_reviews WHERE key=?').get(key);if(current&&current.payload!==value)throw Error('并发相关性判断冲突');db.prepare('INSERT OR IGNORE INTO relevance_reviews VALUES(?,?)').run(key,value);}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 return {run,submitted:validated.length,pending:pendingReviews(db,run).length};
}
export async function collectRadar(db,id,context,collector,options={}){
 const sub=db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id);if(!sub)throw Error('订阅不存在');if(!sub.enabled)throw Error('订阅已暂停');
 const c=JSON.parse(sub.config);if(c.schema_version!==2)throw Error('旧订阅需先 migrate-preview，再 migrate；不推定历史搜索方式');
 const issues=configIssues(c);if(issues.length)throw Error(issues.map(x=>x.question).join('；'));
 const query=radarQuery(c),selection=radarSelection(c,context),plan=radarSearchPlan(c,selection,context);
 const run=randomUUID(),started=new Date().toISOString();
 db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)').run(run,id,sub.revision,started,null,'running',sub.config,null);
 const sourceHashes=Object.fromEntries(selection.companies.map(x=>[x.company_id,hash(x)]));
 const prior=db.prepare("SELECT x.payload FROM run_context x JOIN runs r ON r.id=x.run WHERE r.subscription=? AND r.revision=? AND r.status IN ('complete','partial','failed','empty_scope') ORDER BY r.started DESC LIMIT 1").get(id,sub.revision);
 const previous=prior?JSON.parse(prior.payload):null;
 const snapshot={query,search_plan:plan,selection:selection.summary,source_hashes:sourceHashes,sources:selection.companies,company_records:(context.records?.companies||[]).filter(r=>selection.companies.some(c=>c.company_id===r.company_id)),city_index:context.cities?.[c.mode]||null,query_hash:hash(query),company_ids:selection.companies.map(x=>x.company_id)};
 db.prepare('INSERT INTO run_context VALUES(?,?)').run(run,json(snapshot));
 try{
  for(const company of selection.companies){
   let result;try{result=await collector(company,{mode:'full',targetMode:c.mode,maxPages:options.maxPages||100,timeoutMs:options.timeoutMs||20000,cities:query.city_filters,searchPlan:plan,query});}catch(e){result={jobs:[],coverage:{status:'failed',reason:e.message}};}
   result.migration_bridge=!previous&&!!db.prepare('SELECT 1 FROM migration_state WHERE subscription=?').get(id);
   const hasHistory=!!db.prepare('SELECT 1 FROM jobs WHERE subscription=? AND revision=? AND company=? LIMIT 1').get(id,sub.revision,company.company_id);
   result.baseline_reset=!!(previous&&hasHistory&&(previous.query_hash!==snapshot.query_hash||previous.source_hashes[company.company_id]!==sourceHashes[company.company_id]));
   if(result.source_config_fingerprint&&result.source_config_fingerprint!==sourceConfigFingerprint(company,c.mode))result.baseline_reset=true;
   result.comparison_allowed=!(result.baseline_reset||result.migration_bridge);
   result.jobs=(result.jobs||[]).map(j=>({...j,company_id:company.company_id}));
   // Full-JD role review is separate from both collection and personal assessment.
   if(query.retrieval.mode==='exhaustive'&&query.roles.length)for(const job of result.jobs){
    const request=relevanceRequest(job,query),key=relevanceKey(request);
    db.prepare('INSERT OR IGNORE INTO review_requests VALUES(?,?,?)').run(run,key,json(request));
   }
   db.prepare('INSERT INTO staged_results VALUES(?,?,?)').run(run,company.company_id,json({company,result}));
  }
  db.prepare("UPDATE runs SET status='awaiting_review' WHERE id=?").run(run);
  return run;
 }catch(e){db.prepare("UPDATE runs SET status='failed',finished=?,error=? WHERE id=?").run(new Date().toISOString(),e.message,run);throw e;}
}
export function finalizeRadar(db,run,ingest){
 const r=db.prepare('SELECT * FROM runs WHERE id=?').get(run);if(!r)throw Error('运行不存在');
 if(!['awaiting_review','finalizing'].includes(r.status))return {run,status:r.status,pending:0};
 const pending=pendingReviews(db,run);if(pending.length)return {run,status:'awaiting_review',pending:pending.length};
 const c=JSON.parse(r.config),snapshot=JSON.parse(db.prepare('SELECT payload FROM run_context WHERE run=?').get(run).payload);
 db.prepare("UPDATE runs SET status='finalizing' WHERE id=?").run(run);
 for(const row of db.prepare('SELECT company,payload FROM staged_results WHERE run=?').all(run)){
  if(db.prepare('SELECT 1 FROM coverage WHERE run=? AND company=?').get(run,row.company))continue;
  const {company,result}=JSON.parse(row.payload);
  if(snapshot.query.retrieval.mode==='exhaustive'&&snapshot.query.roles.length)for(const job of result.jobs){const key=relevanceKey(relevanceRequest(job,snapshot.query)),review=db.prepare('SELECT payload FROM relevance_reviews WHERE key=?').get(key);if(!review)throw Error('相关性审阅结果缺失');job.role_relevance=JSON.parse(review.payload);}
  ingest(db,run,c,r.revision,company,result,r.started);
 }
 const coverage=db.prepare('SELECT payload FROM coverage WHERE run=?').all(run).map(x=>JSON.parse(x.payload));
 const status=!coverage.length?'empty_scope':coverage.every(x=>x.status==='complete')?'complete':coverage.every(x=>x.status==='failed')?'failed':'partial';
 db.prepare('UPDATE runs SET status=?,finished=? WHERE id=?').run(status,new Date().toISOString(),run);
 return {run,status,pending:0};
}
