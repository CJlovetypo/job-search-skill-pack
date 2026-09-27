import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {MODE_ROOTS} from '../../../../scripts/runtime.mjs';
import {PACK_ROOT} from '../../../../../shared/job-search-core/runtime-context.mjs';
import {auditLabels,reviewLabels,maintenanceCommand} from '../../../../../shared/job-search-core/scripts/company-maintenance.mjs';
const exec=promisify(execFile),read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const write=async(p,v)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(v));};

test('maintenance audit records gaps without reclassifying supplied facts; command routing is explicit',()=>{
 const registry={companies:[{company_id:'a',industry_tags:['internet']},{company_id:'b',industry_tags:['bad-id']}]},business={companies:[{company_id:'a',business_tags:['网络安全'],status:'unknown'}]},ownership={companies:[]};
 const before=JSON.stringify({registry,business,ownership});
 const result=auditLabels({registry,business,ownership,cities:{campus:{companies:[]}}});
 assert.equal(result.industry_issues.length,1);assert.equal(result.business_issues.length,2);assert.equal(result.ownership_issues.length,2);assert.equal(result.cities.campus.missing,2);
 assert.equal(JSON.stringify({registry,business,ownership}),before);
 assert.throws(()=>maintenanceCommand('cities',{}),/显式/);
 assert.throws(()=>maintenanceCommand('cities',{mode:'campus',cities:'上海'}),/不支持/);
 assert.throws(()=>maintenanceCommand('audit',{apply:true}),/不支持/);
 const preview=maintenanceCommand('ownership',{source:'supplier'});assert(!preview.args.includes('--apply'));
 assert(maintenanceCommand('ownership',{source:'waiqi',apply:true}).args.includes('--apply'));
 const review=reviewLabels({registry,business,ownership});
 assert.equal(review.summary.companies,2);assert.equal(review.summary.business_partial,1);assert.equal(review.summary.business_missing,1);
 assert.equal(review.companies[0].industry.status,'current_routing_retained');assert.equal(review.companies[0].business.status,'partial_evidence');
 assert.equal(maintenanceCommand('review',{out:'shared/job-search-core/state/maintenance/review.json'}),null);
});

test('all three product directions consume labels read-only; explicit maintenance alone updates city index',async()=>{
 const base=path.join(PACK_ROOT,'shared/job-search-core/state/maintenance/label-isolation-tests');await fs.mkdir(base,{recursive:true});
 const root=await fs.mkdtemp(path.join(base,'pack-'));
 const core=path.join(root,'shared/job-search-core');
 await fs.mkdir(core,{recursive:true});
 for(const file of ['runtime-context.mjs','maintenance-paths.mjs','registry.mjs','launcher.mjs','cli.mjs'])await fs.copyFile(path.join(PACK_ROOT,'shared/job-search-core',file),path.join(core,file));
 await fs.cp(path.join(PACK_ROOT,'shared/job-search-core/scripts'),path.join(core,'scripts'),{recursive:true});
 await fs.cp(path.join(PACK_ROOT,'job-search/scripts'),path.join(root,'job-search/scripts'),{recursive:true});
 await fs.mkdir(path.join(core,'assets'),{recursive:true});
 await fs.copyFile(path.join(PACK_ROOT,'shared/job-search-core/assets/custom-providers.json'),path.join(core,'assets/custom-providers.json'));
 await write(path.join(core,'assets/sources.json'),{companies:[{company_id:'synthetic',display_name:'合成公司',provider:'beisen',industry_tags:['internet'],primary_entry_url:'https://example.invalid/jobs'}]});
 for(const file of ['company-business-tags','company-ownership-tags','company-profiles','company-size-tags'])await write(path.join(core,'data',file+'.json'),{companies:[]});
 await fs.copyFile(path.join(PACK_ROOT,'shared/job-search-core/data/business-taxonomy.json'),path.join(core,'data/business-taxonomy.json'));
 await write(path.join(core,'data/company-profiles.json'),{companies:[{company_id:'synthetic',business:{status:'verified',value:'缺少来源的合成简介'}}]});
 // Only the isolated copy gets a deterministic collector; no live provider calls.
 const collector=path.join(core,'scripts/lib/source-collector.mjs');
 const original=await fs.readFile(collector,'utf8');assert(original.includes('export async function collectCompanySources('));
 await fs.writeFile(collector,original.replace('export async function collectCompanySources(','async function unusedRealCollector(')+`
 export async function collectCompanySources(company,options={}) {
   const fs=await import('node:fs/promises');await fs.appendFile(process.env.LABEL_TEST_LOG,JSON.stringify({company:company.company_id,mode:options.mode})+'\\n');
   return {company_id:company.company_id,checked_at:'2026-09-22T00:00:00Z',source_config_fingerprint:sourceConfigFingerprint(company),coverage:{status:'complete',collection_complete:true},requests:[],jobs:[{job_id:'j1',title:'项目管理',formal_status:SEARCH_MODE.id==='campus'?'formal':SEARCH_MODE.id,open_status:'open',cities:['深圳'],locations_raw:['深圳'],recruitment_evidence:{provider:'beisen',CategoryId:SEARCH_MODE.id==='internship'?3:SEARCH_MODE.id==='social'?1:2},description:'负责项目计划编排、里程碑跟踪、风险记录及跨部门沟通，推动项目按计划完成。',requirements:'具备清晰的书面表达、问题分析和项目管理能力，能够独立整理进度并协同解决执行问题。',body_complete:true,official_url:'https://example.invalid/jobs/j1'}]};
 }
 `);
 const guard=path.join(root,'network-guard.cjs');await fs.writeFile(guard,"globalThis.fetch=()=>{throw Error('Live network forbidden in label tests')};");
 const log=path.join(root,'calls.jsonl');
 const cli=async(entry,...args)=>exec(process.execPath,['--require',guard,entry,...args],{cwd:root,env:{...process.env,LABEL_TEST_LOG:log},windowsHide:true,maxBuffer:8e6,timeout:30000});
 const main=path.join(root,'job-search/scripts/jobs.mjs'),maintenance=path.join(core,'scripts/company-maintenance.mjs');
 const stableFiles=['assets/sources.json',...['company-business-tags','company-ownership-tags','company-profiles','company-size-tags'].map(f=>'data/'+f+'.json')];
 const before=await Promise.all(stableFiles.map(f=>fs.readFile(path.join(core,f),'utf8')));
 for(const [mode,skill] of Object.entries(MODE_ROOTS)){
   const skillRoot=path.join(root,skill);await fs.mkdir(path.join(skillRoot,'scripts'),{recursive:true});
   const name=mode==='campus'?'campus.mjs':'jobs.mjs';await fs.copyFile(path.join(PACK_ROOT,skill,'scripts',name),path.join(skillRoot,'scripts',name));
   await write(path.join(skillRoot,'assets/search-mode.json'),{mode});
   const input=path.join(skillRoot,'runs/input.json');await write(input,{is_test:true,industry_filters:['internet'],city_filters:['上海'],evidence:[]});
   const entry=path.join(skillRoot,'scripts',name),city=path.join(core,'data/recruitment',mode,'company-city-index.json');
   await assert.rejects(cli(main,'catalog','--mode',mode,'--industries','internet','--cities','上海'),/城市索引不可用/);
   const profileStatus=JSON.parse((await cli(main,'company-profiles','--mode',mode,'status')).stdout);
   assert.equal(profileStatus.verified.business,0);assert.equal(profileStatus.data_issues.length,1);
   assert.deepEqual(await Promise.all(stableFiles.map(f=>fs.readFile(path.join(core,f),'utf8'))),before);
   await assert.rejects(fs.access(city));
   await assert.rejects(cli(entry,'prepare','--profile',input,'--out',path.join(skillRoot,'runs/missing')),/城市索引不可用/);await assert.rejects(fs.access(city));
   const openInput=path.join(skillRoot,'runs/open.json');await write(openInput,{is_test:true,industry_filters:['internet'],city_filters:[],evidence:[]});
   await cli(entry,'prepare','--profile',openInput,'--out',path.join(skillRoot,'runs/open'));
   assert.equal((await read(path.join(skillRoot,'runs/open/run.json'))).companies[0].selected,true);await assert.rejects(fs.access(city));
   await write(city,{companies:[{company_id:'synthetic',cities:['上海'],updated_at:'2000-01-01',source_config_fingerprint:'old-config',search_mode:mode}]});
   const cityBefore=await fs.readFile(city,'utf8');
   const catalog=JSON.parse((await cli(main,'catalog','--mode',mode,'--industries','internet','--cities','上海')).stdout);assert.equal(catalog.selected_companies,1);
   const dir=path.join(skillRoot,'runs/selected');await cli(entry,'prepare','--profile',input,'--out',dir);
   const run=await read(path.join(dir,'run.json'));assert.equal(run.companies[0].ownership_status,'unknown');assert.equal(run.companies[0].ownership_tag,'待核实');
   const facts=await read(path.join(dir,'company-profiles.snapshot.json'));assert.equal(facts.companies[0].business.status,'missing');assert.equal(facts.companies[0].business.unverified_source_fact.value,'缺少来源的合成简介');
   await assert.rejects(fs.access(log));
   await cli(entry,'collect','--run',dir,'--refresh');assert.equal((await read(path.join(dir,'companies/synthetic.json'))).jobs[0].cities[0],'深圳');
   assert.equal(await fs.readFile(city,'utf8'),cityBefore);
   assert.deepEqual(await Promise.all(stableFiles.map(f=>fs.readFile(path.join(core,f),'utf8'))),before);
   const callsBefore=(await fs.readFile(log,'utf8')).trim().split('\n');assert.equal(callsBefore.length,1);
   await cli(maintenance,'cities','--mode',mode,'--only','synthetic','--out',path.join(skillRoot,'artifacts/city-maintenance'));
   const updated=await read(city);assert.deepEqual(updated.companies[0].cities,['深圳']);assert.equal(updated.companies[0].search_mode,mode);
   const history=(await fs.readdir(path.join(skillRoot,'artifacts/city-maintenance'))).find(f=>f.startsWith('index-before'));
   assert(history);assert.deepEqual((await read(path.join(skillRoot,'artifacts/city-maintenance',history))).companies[0].cities,['上海']);
   assert.equal((await read(path.join(dir,'run.json'))).companies[0].city_tags[0],'上海');
   assert.deepEqual(await Promise.all(stableFiles.map(f=>fs.readFile(path.join(core,f),'utf8'))),before);
   await fs.unlink(log);
 }
 const audit=path.join(root,'shared/job-search-core/state/maintenance/audit.json');await cli(maintenance,'audit','--out',audit);assert.equal((await read(audit)).read_only,true);
 await assert.rejects(cli(maintenance,'audit','--out',audit),/EEXIST/);
 const review=path.join(root,'shared/job-search-core/state/maintenance/review.json');await cli(maintenance,'review','--out',review);assert.equal((await read(review)).summary.companies,1);
 await assert.rejects(fs.access(log));
});
