import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {selectQueryCompanies} from '../../../shared/job-search-core/scripts/lib/query-selection.mjs';
import {normalizeConfig,openDb,subscribe,runSubscription,reviewExport,reviewSubmit,finalize,renderReport,selectCompanies} from '../radar.mjs';
import {migrationPreview,migrateDatabase,rollbackMigration} from '../migration.mjs';
const companies=[{company_id:'a',display_name:'游戏公司',industry_tags:['internet'],business_tags:['游戏研发'],provider:'fixture',primary_entry_url:'https://example.invalid/a'},{company_id:'b',display_name:'其他',industry_tags:['internet'],business_tags:['游戏研发']}];
const context={registry:{companies},records:{companies:companies.map(c=>({company_id:c.company_id,tags:{business:c.business_tags,ownership:'私企',headquarters_country:'中国',listing_status:'未上市'}}))},cities:Object.fromEntries(['campus','social','internship'].map(mode=>[mode,{updated_at:'2026-09-27',companies:[{company_id:'a',cities:['上海']},{company_id:'b',cities:['北京']}]}]))};
const config=(mode='social')=>normalizeConfig({id:'test',mode,business_filters:['游戏研发'],cities:['上海'],roles:['项目管理'],retrieval:{mode:'exhaustive',selection:'explicit',basis:'合成测试用户明确选择全量'}},companies,{context});
const job={job_id:'j1',title:'交付协调专员',description:'负责项目计划、里程碑和跨部门风险协调。',requirements:'有三年项目管理经验。',formal_status:'social',open_status:'open',body_complete:true,cities:['上海'],official_url:'https://example.invalid/j1'};
const result=(jobs=[job],status='complete')=>({jobs:structuredClone(jobs),coverage:{status,pages:1}});
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'radar-shared-'));const file=path.join(dir,'radar.sqlite'),db=openDb(file);return {dir,file,db};}
const judgment=(request,status='related')=>({...request,status,reason:'职责原文体现项目计划与风险协调。',evidence:[request.description]});
test('all directions share static filters and city preselection; soft cities and unavailable index differ',()=>{
 for(const mode of ['campus','internship','social']){
  const c=config(mode),q={mode,business_filters:c.business_filters,city_filters:c.cities,ownership_filters:['私企'],headquarters_country_filters:['中国']};
  assert.deepEqual(selectQueryCompanies(context,q).companies.map(x=>x.company_id),['a']);
  assert.deepEqual(selectCompanies({...c,ownership_filters:['私企'],headquarters_country_filters:['中国']},companies,context).map(x=>x.company_id),['a']);
  assert.equal(selectCompanies({...c,city_preference:{importance:'prefer'}},companies,context).length,2);
  assert.throws(()=>selectCompanies(c,companies,{registry:{companies}}),/城市索引不可用/);
 }
 assert.throws(()=>normalizeConfig({id:'missing',mode:'social',keywords:['PM']},companies),/行业.*搜索方式|行业.*标题定向/);
});
test('full-JD radar stages different-title jobs, rejects bad reviews, resumes and reuses unchanged reviews',async()=>{
 const {db}=setup();try{
  subscribe(db,config());let calls=0;const collect=async()=>{calls++;return result();};
  const run=await runSubscription(db,'test',companies,collect,{context});assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get(run).status,'awaiting_review');assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,0);
  const [request]=reviewExport(db,run).items;assert.equal(request.title,'交付协调专员');assert.match(renderReport(db,run),/全文相关性待审/);
  assert.throws(()=>reviewSubmit(db,run,[{...judgment(request),job_fingerprint:'bad'}]),/不属于/);
  assert.throws(()=>reviewSubmit(db,run,[judgment(request),judgment(request,'unrelated')]),/冲突/);
  reviewSubmit(db,run,[judgment(request)]);reviewSubmit(db,run,[judgment(request)]);
  assert.equal(finalize(db,run).status,'complete');assert.equal(db.prepare('SELECT kind FROM events WHERE run=?').get(run).kind,'new');
  const next=await runSubscription(db,'test',companies,collect,{context});assert.equal(calls,2);assert.equal(reviewExport(db,next).items.length,0);assert.equal(db.prepare('SELECT count(*) n FROM events WHERE run=?').get(next).n,0);
  const changed=await runSubscription(db,'test',companies,async()=>result([{...job,description:'负责现场行政支持。'}]),{context});const [fresh]=reviewExport(db,changed).items;reviewSubmit(db,changed,[judgment(fresh,'unrelated')]);finalize(db,changed);assert.equal(db.prepare('SELECT kind FROM events WHERE run=?').get(changed).kind,'matching_changed');
 }finally{db.close();}
});
test('city exclusion, failed/partial scans and source changes never infer disappearance',async()=>{
 const {db}=setup();try{
  const c={...config(),roles:[],keywords:[]};subscribe(db,c);
  await runSubscription(db,'test',companies,async()=>result(),{context});
  for(const status of ['failed','partial']){const r=await runSubscription(db,'test',companies,async()=>result([],status),{context});assert.equal(db.prepare('SELECT count(*) n FROM events WHERE run=?').get(r).n,0);}
  const changed=structuredClone(context);changed.registry.companies[0].primary_entry_url+='?new';const r=await runSubscription(db,'test',companies,async()=>result([]),{context:changed});assert.equal(db.prepare('SELECT count(*) n FROM events WHERE run=?').get(r).n,0);
  const empty=structuredClone(context);empty.cities.social.companies=[];const e=await runSubscription(db,'test',companies,async()=>{throw Error('should not fetch');},{context:empty});assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get(e).status,'empty_scope');assert.equal(db.prepare('SELECT missing FROM jobs').get().missing,0);
 }finally{db.close();}
});
test('legacy migration preserves paused history, waits for actual strategy, is idempotent and rolls back transactionally',()=>{
 const {file,db}=setup();const old={...config(),keywords:['项目管理']};delete old.schema_version;delete old.retrieval;
 subscribe(db,old);db.exec("UPDATE subscriptions SET enabled=0; PRAGMA user_version=0; DROP TABLE migration_state;");db.close();
 const before=migrationPreview(file,companies);assert.equal(before.subscriptions[0].enabled,false);assert.equal(before.subscriptions[0].issues[0].field,'retrieval');
 const waiting=migrateDatabase(file,companies);assert(waiting.changed);assert.equal(migrateDatabase(file,companies).changed,false);
 rollbackMigration(waiting.receipt);assert(migrationPreview(file,companies).needed);
 const applied=migrateDatabase(file,companies,{patches:[{id:'test',retrieval:{mode:'targeted',selection:'explicit',basis:'测试中用户选择标题'},keyword_reasons:[{keyword:'项目管理',reason:'用户关注职能的直接标题表述'}]}]});assert(applied.changed);assert.equal(migrateDatabase(file,companies).changed,false);
 const check=openDb(file);assert.equal(check.prepare('SELECT enabled FROM subscriptions').get().enabled,0);assert.equal(check.prepare('SELECT revision FROM subscriptions').get().revision,1);check.exec("UPDATE subscriptions SET enabled=1");check.close();assert.throws(()=>rollbackMigration(applied.receipt),/已变化/);
});
test('migration bridges old jobs while reporting actual new IDs; newly eligible companies report new jobs',async()=>{
 const {db}=setup();try{
  const c={...config(),roles:[],keywords:[]};subscribe(db,c);await runSubscription(db,'test',companies,async()=>result(),{context});
  db.exec('DELETE FROM run_context');db.prepare('INSERT INTO migration_state VALUES(?,?)').run('test',JSON.stringify({status:'migrated'}));
  const run=await runSubscription(db,'test',companies,async()=>result([job,{...job,job_id:'j2'}]),{context});
  assert.deepEqual(db.prepare('SELECT job,kind FROM events WHERE run=?').all(run).map(x=>({...x})),[{job:'j2',kind:'new'}]);
  const expanded=structuredClone(context);expanded.cities.social.companies[1].cities=['上海'];
  const added=await runSubscription(db,'test',companies,async company=>result(company.company_id==='a'?[job,{...job,job_id:'j2'}]:[{...job,job_id:'b1'}]),{context:expanded});
  assert.equal(db.prepare('SELECT kind FROM events WHERE run=? AND company=?').get(added,'b').kind,'new');
 }finally{db.close();}
});
