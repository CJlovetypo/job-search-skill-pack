import {datasetPath} from '../../../../../shared/job-search-core/registry.mjs';
import {PACK_ROOT} from '../../../../../shared/job-search-core/runtime-context.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import fs from 'node:fs/promises';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {INDUSTRIES,normalizeIndustries,routeCompanies} from '../lib/industry-routing.mjs';import {collectCompanySources,mergeSourceResults,sourceConfigFingerprint,sourceCacheMatches} from '../lib/source-collector.mjs';import {SKILL_ROOT,readJson,writeJson} from '../lib/io.mjs';
const exec=promisify(execFile),cli=path.join(SKILL_ROOT,'scripts/campus.mjs');
await fs.mkdir(path.join(SKILL_ROOT,'artifacts/industry-merge'),{recursive:true});
const run=async(...args)=>{const r=await exec(process.execPath,[cli,...args],{cwd:SKILL_ROOT,maxBuffer:10e6});return JSON.parse(r.stdout.trim());};
test('industry is explicit, multiselect unions companies, and all is deliberate',()=>{
 assert.throws(()=>normalizeIndustries(),/请先指定行业/);assert.throws(()=>normalizeIndustries([]),/请先指定行业/);assert.throws(()=>normalizeIndustries(['unknown']),/未识别/);
 assert.deepEqual(normalizeIndustries(['互联网','智能硬件']),['internet','smart_hardware']);assert.deepEqual(normalizeIndustries('不限行业'),['all']);
 const companies=[{company_id:'a',industry_tags:['internet','smart_hardware']},{company_id:'b',industry_tags:['smart_hardware']},{company_id:'c',industry_tags:['automotive_oem']}];
 assert.deepEqual(routeCompanies(companies,['internet','smart_hardware']).map(c=>c.company_id),['a','b']);assert.equal(routeCompanies(companies,['all']).length,3);
});

test('expanded industries route companies without assuming ownership or replacing business preferences',async()=>{
 assert.deepEqual(normalizeIndustries(['银行','医疗','农林牧渔','金融']),['finance','healthcare','agriculture']);
 const current=(await readJson(datasetPath(SKILL_ROOT,'assets/sources.json'))).companies;
 for(const industry of INDUSTRIES)assert(current.some(c=>c.industry_tags.includes(industry.id)),industry.id+' has no admitted source');
 const finance=await run('catalog','--industries','finance','--only','易方达基金');assert.equal(finance.selected_companies,1);assert.equal(finance.ownership_pending.length,0);
 const mixed=await run('catalog','--industries','finance,healthcare');assert.equal(mixed.selected_companies,new Set(mixed.companies.map(c=>c.company_id)).size);
 await assert.rejects(()=>run('catalog','--industries','healthcare','--only','易方达基金'),/行业范围冲突/);
 const shanghai=await run('catalog','--industries','finance','--cities','上海');assert(shanghai.selected_companies>0);assert(shanghai.companies.every(c=>c.cities.includes('上海')));
});
test('catalog uses published API ownership and business labels for company preferences',async()=>{
 const records=JSON.parse(await fs.readFile(path.join(PACK_ROOT,'shared/job-search-core/data/company-records.json'),'utf8'));
 for(const ownership of ['国企','外企']) {
  const company=records.companies.find(c=>c.governance.fields['tags.ownership'].status==='api_supported'&&c.tags.ownership===ownership&&c.tags.industry.length&&c.tags.business.length&&c.governance.fields['tags.business'].status==='api_supported');
  assert(company,'缺少可验证的 API 公司性质样本：'+ownership);
  const file=path.join(SKILL_ROOT,'artifacts/industry-merge/api-'+ownership+'.json');
  await writeJson(file,{industry_filters:[company.tags.industry[0]],company_filters:[company.company_id],city_filters:[],ownership_filters:[ownership],ownership_preferences:[ownership],business_preferences:[company.tags.business[0]]});
  const result=await run('catalog','--profile',file);
  assert.equal(result.selected_companies,1);assert.equal(result.companies[0].ownership_tag,ownership);
  assert.equal(result.companies[0].ownership_status,'api_supported');
  assert.equal(result.companies[0].ownership_alignment.status,'aligned');
  assert.equal(result.companies[0].business_alignment.status,'aligned');
  await writeJson(file,{industry_filters:[company.tags.industry[0]],company_filters:[company.company_id],city_filters:[],ownership_filters:[ownership==='国企'?'外企':'国企']});
  await assert.rejects(()=>run('catalog','--profile',file),/性质范围冲突/);
 }
});

test('company metadata keys agree and known duplicate employer aliases remain merged',async()=>{
 const companies=(await readJson(datasetPath(SKILL_ROOT,'assets/sources.json'))).companies;
 const ids=companies.map(c=>c.company_id).sort();for(const file of ['company-city-index','company-business-tags','company-ownership-tags','company-profiles']){
  const rows=(await readJson(path.join(SKILL_ROOT,'data/'+file+'.json'))).companies;assert.deepEqual(rows.map(c=>c.company_id).sort(),ids,file);
 }
 // Recovered public suite config identifies both Hotjob portals as one 中冶长天 tenant.
 const zhongye=companies.filter(c=>c.display_name==='中冶长天');assert.equal(zhongye.length,1);assert.equal(zhongye[0].company_id,'co_f99d8a693504e99ccc83');assert.equal(zhongye[0].recruitment_sources.length,2);
 for(const duplicate of ['飞鹤','长飞公司','中国信通院','杰瑞股份','金田集团','卓越教育','江苏交控','中金财富','德勤中国咨询业务','广发证券分支机构','奥纬咨询','和天国际'])assert(!companies.some(c=>c.display_name===duplicate),duplicate);
});
test('merged registry preserves original IDs, covers every source, and corrects the mislabeled portal',async()=>{
 const current=(await readJson(datasetPath(SKILL_ROOT,'assets/sources.json'))).companies;
 const baseline=[{company_id:'company-7ca2b7da6e0f',display_name:'科大讯飞',provider:'beisen'},{company_id:'company-45d4e09fc97b',display_name:'轻舟智航',provider:'feishu'},{company_id:'company-3d1930c4cd50',display_name:'中科创达',provider:'feishu'},{company_id:'company-ad28e918f26b',display_name:'Momenta',provider:'feishu'}];
 assert.equal(new Set(current.map(c=>c.company_id)).size,current.length);
 for(const old of baseline){const c=current.find(c=>c.company_id===old.company_id);assert.equal(c.display_name,old.display_name);assert(c.industry_tags.includes('internet'));assert.equal(c.provider,old.provider);}
 for(const c of current){assert(c.industry_tags.length);for(const s of c.recruitment_sources||[]){assert.equal(s.company_id,c.company_id);assert(s.source_id&&s.provider&&s.primary_entry_url);}}
 assert.equal(current.filter(c=>c.display_name==='科大讯飞').length,1);assert(current.find(c=>c.display_name==='科大讯飞').industry_tags.includes('smart_hardware'));
 assert(!current.some(c=>c.display_name==='威盛电子'));assert.deepEqual(current.find(c=>c.display_name==='MiniMax').industry_tags,['internet']);
});
test('all company endpoints are visited despite one failure; IDs stay stable and cross-platform collisions are isolated',async()=>{
 const company={company_id:'fixture',display_name:'测试',provider:'moka',recruitment_sources:[{source_id:'a',provider:'moka'},{source_id:'broken',provider:'beisen'},{source_id:'b',provider:'moka'},{source_id:'c',provider:'feishu'}]},seen=[];
 const result=await collectCompanySources(company,{},async s=>{seen.push(s.source_id);if(s.source_id==='broken')throw Error('fixture API unavailable');return {jobs:[{job_id:'1',description:'真实测试职责正文',requirements:'真实测试要求正文',body_complete:true,formal_status:'formal'}],coverage:{status:'complete',pages:1},requests:[]};});
 assert.deepEqual(seen,['a','broken','b','c']);assert.equal(result.coverage.status,'partial');assert.deepEqual(result.jobs.map(j=>j.job_id),['1','feishu:1']);assert.deepEqual(result.jobs[0].source_ids,['a','b']);
});
test('contradictory recruitment metadata remains unresolved after a third source agrees with the first',()=>{
 const c={company_id:'test',display_name:'测试',provider:'moka'};const input=['formal','internship','formal'].map((formal_status,i)=>({source:{provider:'moka',source_id:String(i)},result:{jobs:[{job_id:'1',formal_status,body_complete:true}],coverage:{status:'complete'}}}));
 const result=mergeSourceResults(c,input);assert.equal(result.jobs[0].formal_status,'unknown');assert.deepEqual(result.jobs[0].recruitment_evidence.conflicting_recruitment_types,['formal','internship']);
});
const profile=()=>({is_test:true,summary:'行业分流开发测试，不是真实用户',graduation:'2027-06',degree:'本科',city_filters:[],industry_filters:['internet'],evidence:[{id:'E1',text:'合成经历：参与招聘面试协调',source:'合成测试画像',kind:'resume',claim_type:'objective_experience',experience_type:'internship',experience_id:'I1'}]});
test('CLI routes before preparation, excludes unrelated industry metadata gaps, and never assumes an omitted industry',async()=>{
 const dir=await fs.mkdtemp(path.join(SKILL_ROOT,'artifacts/industry-merge/test-')),file=path.join(dir,'profile.json'),p=profile();p.company_filters=['腾讯'];await writeJson(file,p);
 await run('prepare','--profile',file,'--out',path.join(dir,'internet'));const prepared=await readJson(path.join(dir,'internet/run.json'));assert.equal(prepared.companies.length,1);assert.equal(prepared.companies[0].display_name,'腾讯');assert(prepared.selection_summary.excluded_by_industry>0);
 delete p.industry_filters;await writeJson(file,p);await assert.rejects(()=>run('prepare','--profile',file,'--out',path.join(dir,'missing')),/请先指定行业/);
 p.industry_filters=['automotive_oem'];await writeJson(file,p);await assert.rejects(()=>run('prepare','--profile',file,'--out',path.join(dir,'conflict')),/行业范围冲突/);
 const both=await run('catalog','--industries','internet,smart_hardware','--only','科大讯飞');assert.equal(both.selected_companies,1);assert.equal(both.ownership_pending.length,0);
});
test('demo ownership stays explicit and does not block city exclusions',async()=>{
 const catalog=await run('catalog','--industries','smart_hardware','--only','格力');assert.equal(catalog.selected_companies,1);assert.equal(catalog.ownership_pending.length,0);
 const dir=await fs.mkdtemp(path.join(SKILL_ROOT,'artifacts/industry-merge/test-')),file=path.join(dir,'profile.json'),p={...profile(),industry_filters:['smart_hardware'],company_filters:['格力']};await writeJson(file,p);
 await run('prepare','--profile',file,'--out',path.join(dir,'researched'));const researched=await readJson(path.join(dir,'researched/run.json'));assert.equal(researched.companies[0].selected,true);assert.equal(researched.companies[0].ownership_status,'demo_unreviewed');
 const absentCity=['北京','上海','拉萨','哈尔滨','武汉'].find(city=>!catalog.companies[0].cities.includes(city));assert(absentCity);
 p.city_filters=[absentCity];await writeJson(file,p);await run('prepare','--profile',file,'--out',path.join(dir,'excluded'));const prepared=await readJson(path.join(dir,'excluded/run.json'));assert.equal(prepared.companies[0].selected,false);assert.equal(prepared.companies[0].ownership_status,'demo_unreviewed');
});
test('deliberately skipped non-target city bodies and list-only collection preserve coverage',()=>{
 const company={company_id:'test',display_name:'测试',provider:'moka'},source={provider:'moka',source_id:'a'};
 const job={job_id:'1',formal_status:'formal',open_status:'open',body_complete:false,detail_skipped_reason:'explicit_non_target_city'};
 const merge=(j,options)=>mergeSourceResults(company,[{source,result:{jobs:[j],coverage:{status:'complete'}}}],options);
 assert.equal(merge(job).coverage.status,'complete');
 const included={...job,detail_skipped_reason:undefined};assert.equal(merge(included).coverage.status,'partial');assert.equal(merge(included,{mode:'list'}).coverage.status,'complete');
});
test('source changes invalidate reusable snapshots, including legacy single-source results',async()=>{
 const company={company_id:'test',provider:'moka',primary_entry_url:'https://example.test/campus'},first={...company,source_id:'a'},merged={...company,recruitment_sources:[first]};
 assert.equal(sourceCacheMatches({},company),true);assert.equal(sourceCacheMatches({},merged),false);
 const result=await collectCompanySources(merged,{},async()=>({jobs:[],coverage:{status:'complete'}}));assert.equal(sourceCacheMatches(result,merged),true);
 assert.equal(sourceCacheMatches(result,{...merged,recruitment_sources:[first,{...first,source_id:'b',primary_entry_url:'https://example.test/other'}]}),false);
 assert.notEqual(sourceConfigFingerprint(merged),sourceConfigFingerprint({...merged,recruitment_sources:[{...first,api_config:{orgId:2}}]}));
});
test('different tenants keep equal IDs separate while Moka portal aliases merge',()=>{
 const company={company_id:'test',display_name:'测试',provider:'beisen',primary_entry_url:'https://first.example.test/campus'};
 const input=urls=>urls.map((url,i)=>({source:{provider:company.provider,source_id:String(i),primary_entry_url:url},result:{jobs:[{job_id:'7',formal_status:'formal',open_status:'open',body_complete:true}],coverage:{status:'complete'}}}));
 const distinct=mergeSourceResults(company,input([company.primary_entry_url,'https://second.example.test/campus']));assert.equal(distinct.jobs.length,2);assert.equal(distinct.jobs[0].job_id,'7');assert.notEqual(distinct.jobs[1].job_id,'7');
 company.provider='moka';company.primary_entry_url='https://app.mokahr.com/campus-recruitment/exampleorg/12';
 const aliases=mergeSourceResults(company,input([company.primary_entry_url,'https://careers.example.test/social-recruitment/exampleorg/34']));assert.equal(aliases.jobs.length,1);assert.deepEqual(aliases.jobs[0].source_ids,['0','1']);
});
