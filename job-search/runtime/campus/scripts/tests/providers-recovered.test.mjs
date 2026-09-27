import './context.mjs';
// Offline contract fixtures: entirely synthetic; no raw captures, network, or credentials.
// RECOVERED_ADAPTER_DIR may point at the production lib directory after integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mergeSourceResults} from '../lib/source-collector.mjs';
const dir=process.env.RECOVERED_ADAPTER_DIR||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../lib');
const {collectRecovered:recovered,normalizeRecovered}=await import(pathToFileURL(path.join(dir,'providers-recovered.mjs')));
const {collectOracleNowcoder:oracleNowcoder,normalizeOracleNowcoder}=await import(pathToFileURL(path.join(dir,'providers-oracle-nowcoder.mjs')));
const {collectXYZ:xyz,normalizeXYZ}=await import(pathToFileURL(path.join(dir,'providers-51job-xyz.mjs')));
const collectRecovered=(s,o)=>recovered(s,{mode:'full',...o});
const collectOracleNowcoder=(s,o)=>oracleNowcoder(s,{mode:'full',...o});
const collectXYZ=(s,o)=>xyz(s,{mode:'full',...o});
const body='岗位职责：负责系统设计与功能验证，编写设计文档并与团队协作完成交付。任职要求：本科及以上学历，具备扎实的专业基础与良好的沟通能力，能够独立分析问题。';
test('merged public-platform results isolate identical IDs in different employer tenants',()=>{
 const a={provider:'51job_coapi',primary_entry_url:'https://campus.51job.com/a/',api_config:{ctmid:'101'},source_id:'a'},b={...a,api_config:{ctmid:'102'},source_id:'b'};
 const company={...a,company_id:'group',display_name:'测试集团'},job={job_id:'same',title:'岗位',body_complete:true,description:'职责',requirements:'要求',formal_status:'unknown',open_status:'open'};
 const result={jobs:[job],coverage:{status:'complete',pages:1}};
 const merged=mergeSourceResults(company,[{source:a,result},{source:b,result}]);assert.equal(merged.jobs.length,2);assert.equal(new Set(merged.jobs.map(j=>j.job_id)).size,2);assert.equal(new Set(merged.jobs.map(j=>j.source_job_namespace)).size,2);
});
const source={company_id:'synthetic-a',display_name:'测试公司甲',provider:'51job_coapi',api_config:{ctmid:'101'}};
const detail=(id,tenant='101')=>({ctmid:tenant,jobid:id,jobname:'研发工程师',jobinfo:body,jobareaname:'上海',coname:'测试公司甲',term:'全职',workyearname:'在校生/应届生'});
const page=(ids,total,tenant='101')=>({totalnum:String(total),joblist:ids.map(id=>{const {jobinfo,...row}=detail(id,tenant);return row;})});
function fakeClient(handler){const records=[];return{records,async request(q,meta){const record={http_status:200,response_file:'synthetic-'+records.length,purpose:meta?.purpose};records.push(record);const data=await handler(q,meta);return{data,text:JSON.stringify(data),record};}};}
function coClient(pages,{fail=[],tenant='101',detailTenant=tenant}={}){let n=0;return fakeClient(q=>{if(q.url.includes('job_list.php'))return{status:'1',resultbody:pages[n++]};const id=JSON.parse(new URL(q.url).searchParams.get('params')).jobid;if(fail.includes(id))throw Error('synthetic_detail_failure');return{status:'1',resultbody:detail(id,detailTenant)};});}

test('normal collection enumerates all pages and every detail without a sample cap',async()=>{
 const c=coClient([page(['a','b'],3),page(['c'],3)]);const r=await collectRecovered(source,{client:c,pageSize:2});
 assert.equal(r.coverage.status,'complete');assert.equal(r.coverage.pages,2);assert.equal(r.coverage.list_complete,true);assert.equal(r.coverage.validation_detail_limit,null);assert.equal(r.jobs.length,3);assert.equal(c.records.length,5);assert.ok(r.jobs.every(j=>j.body_complete&&j.open_status==='open'));
});
test('direct-detail and missing-expiry records preserve unknown openness',()=>{
 assert.equal(normalizeRecovered(detail('a'),source,{}).open_status,'unknown');
 assert.equal(normalizeRecovered(detail('a'),source,{},true).open_status,'open');
 assert.equal(normalizeXYZ({jobId:'a',jobName:'研发工程师',jobInfo:body},{api_config:{ehire_ctm_id:'101'}},{}).open_status,'unknown');
 assert.equal(normalizeXYZ({jobId:'a',jobInfo:body,isExpired:true},{api_config:{ehire_ctm_id:'101'}},{}).open_status,'closed');
});
test('failed detail preserves published list identity as incomplete',async()=>{
 const r=await collectRecovered(source,{client:coClient([page(['a','b'],2)],{fail:['a']})});
 assert.equal(r.jobs.length,2);assert.equal(r.coverage.details_failed,1);assert.equal(r.coverage.status,'partial');const j=r.jobs.find(x=>x.job_id==='a');assert.equal(j.body_complete,false);assert.equal(j.open_status,'open');assert.match(j.raw_metadata.detail_fetch_error,/synthetic_detail_failure/);
});
test('changed totals and duplicate IDs never become complete',async()=>{
 const drift=await collectRecovered(source,{client:coClient([page(['a'],2),page(['b','c'],3)]),pageSize:1});assert.equal(drift.coverage.list_complete,false);assert.match(drift.coverage.reason,/server_total_changed/);
 const dup=await collectRecovered(source,{client:coClient([page(['a'],2),page(['a','b'],2)]),pageSize:1});assert.equal(dup.coverage.status,'partial');assert.match(dup.coverage.reason,/duplicate_job_ids/);
});
test('explicit validation limit retains skipped rows and is visibly partial',async()=>{
 const c=coClient([page(['a','b'],2)]);const r=await collectRecovered(source,{client:c,validationMaxDetails:1});assert.equal(r.jobs.length,2);assert.equal(r.coverage.validation_detail_limit,1);assert.equal(r.coverage.status,'partial');assert.equal(c.records.length,2);assert.equal(r.jobs.filter(j=>j.raw_metadata.validation_detail_skipped).length,1);
});
test('same raw job ID stays attached to its source tenant and cross-tenant details fail',async()=>{
 const b={...source,company_id:'synthetic-b',display_name:'测试公司乙',api_config:{ctmid:'202'}};
 const aResult=await collectRecovered(source,{client:coClient([page(['shared'],1)])});
 const bResult=await collectRecovered(b,{client:coClient([page(['shared'],1,'202')],{tenant:'202'})});
 assert.equal(aResult.jobs[0].company_id,'synthetic-a');assert.equal(bResult.jobs[0].company_id,'synthetic-b');assert.equal(aResult.jobs[0].raw_metadata.ctmid,'101');assert.equal(bResult.jobs[0].raw_metadata.ctmid,'202');assert.notEqual(aResult.jobs[0].official_url,bResult.jobs[0].official_url);
 const mismatch=await collectRecovered(source,{client:coClient([page(['shared'],1)],{detailTenant:'202'})});assert.equal(mismatch.jobs[0].body_complete,false);assert.equal(mismatch.coverage.details_failed,1);assert.match(mismatch.coverage.reason,/tenant or job mismatch/);
});
test('campus channel alone does not turn explicit social recruitment into formal',()=>{
 const j=normalizeRecovered({company:{},job:{jobNumber:'a',title:'测试工程师（社招）',detail:body,url:'https://example.invalid/job/a',cityName:'上海'}},{provider:'zhaopin_grace',api_config:{job_source:2}}, {},true);assert.equal(j.formal_status,'social');assert.equal(j.body_complete,true);
});
test('Nowcoder structured internship prevails over a 校招可转正 title',()=>{
 const j=normalizeOracleNowcoder({id:'a',jobName:'实习工程师（校招可转正）',companyId:101,recruitType:2,ext:JSON.stringify({infos:'负责系统功能设计、文档编写与团队交付协作，学习完整的软件开发流程。',requirements:'本科在读，掌握相关专业基础，能够每周参与三天并持续三个月。'}),jobCityList:['上海']},{provider:'nowcoder_public'}, {},true);assert.equal(j.formal_status,'internship');assert.equal(j.body_complete,true);assert.equal(j.open_status,'open');
});
test('Oracle excludes explicit overseas rows before fetching their details',async()=>{
 let details=0;const c=fakeClient(q=>{if(q.url.includes('recruitingCEJobRequisitionDetails')){details++;return{items:[{Id:'cn',Title:'Analyst',PrimaryLocationCountry:'CN',PrimaryLocation:'Shanghai',ExternalDescriptionStr:body}]};}return{items:[{requisitionList:[{Id:'cn',Title:'Analyst',PrimaryLocationCountry:'CN',PrimaryLocation:'Shanghai'},{Id:'us',Title:'Analyst',PrimaryLocationCountry:'US',PrimaryLocation:'New York'}],TotalJobsCount:2}]};});
 const r=await collectOracleNowcoder({provider:'oracle_recruiting',api_config:{origin:'https://example.invalid',site:'X',location_id:'CN'}},{client:c});assert.equal(r.jobs.length,1);assert.equal(r.jobs[0].job_id,'cn');assert.equal(details,1);assert.match(r.coverage.reason,/non-China row excluded/);
});
test('Oracle without location ID paginates the global site and keeps only explicit China rows',async()=>{
 let details=0;const c=fakeClient(q=>{
  if(q.url.includes('recruitingCEJobRequisitionDetails')){details++;const id=q.url.match(/Id=%22([^%]+)%22/)[1];return{items:[{Id:id,Title:'Analyst',PrimaryLocationCountry:'CN',PrimaryLocation:'Shanghai',ExternalDescriptionStr:body}]};}
  const offset=Number(q.url.match(/offset=(\d+)/)[1]);
  const rows=offset===0?[{Id:'us',Title:'Analyst',PrimaryLocationCountry:'US',PrimaryLocation:'New York'}]:[{Id:'cn',Title:'Analyst',PrimaryLocationCountry:'CN',PrimaryLocation:'Shanghai'}];
  return{items:[{requisitionList:rows,TotalJobsCount:2}]};
 });
 const r=await collectOracleNowcoder({provider:'oracle_recruiting',api_config:{origin:'https://example.invalid',site:'X'}},{client:c,pageSize:1});
 assert.deepEqual(r.jobs.map(x=>x.job_id),['cn']);assert.equal(details,1);assert.equal(r.coverage.status,'complete');assert.equal(r.coverage.list_complete,true);
 assert.equal(r.coverage.global_rows_observed,2);assert.equal(r.coverage.excluded_location_rows.length,1);assert.match(r.coverage.scope,/global Oracle site pagination/i);
 assert.ok(c.records.some(x=>x.purpose==='global_job_list_for_cn_filter'));
});
test('Oracle global country scan stays partial when maxPages cannot reconcile the site total',async()=>{
 const c=fakeClient(()=>({items:[{requisitionList:[{Id:'cn',Title:'Analyst',PrimaryLocationCountry:'CN',PrimaryLocation:'Shanghai'}],TotalJobsCount:2}]}));
 const r=await collectOracleNowcoder({provider:'oracle_recruiting',api_config:{origin:'https://example.invalid',site:'X'}},{client:c,pageSize:1,maxPages:1});
 assert.equal(r.jobs.length,1);assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.list_complete,false);assert.match(r.coverage.reason,/max_pages_reached/);
});
test('Oracle detail failure preserves the observed China list row',async()=>{
 const c=fakeClient(q=>{if(q.url.includes('recruitingCEJobRequisitionDetails'))throw Error('synthetic_detail_failure');return{items:[{requisitionList:[{Id:'cn',Title:'Analyst',PrimaryLocationCountry:'CN',PrimaryLocation:'Shanghai'}],TotalJobsCount:1}]};});
 const r=await collectOracleNowcoder({provider:'oracle_recruiting',api_config:{origin:'https://example.invalid',site:'X',location_id:'CN'}},{client:c});assert.equal(r.jobs.length,1);assert.equal(r.jobs[0].body_complete,false);assert.equal(r.coverage.details_failed,1);assert.equal(r.coverage.status,'partial');
});
test('Greenhouse keeps explicit mainland and mixed locations, excludes foreign-only',async()=>{
 const jobs=['Shanghai','Shanghai / Singapore','New York'].map((location,i)=>({id:String(i),title:'Engineer',content:body,location:{name:location},absolute_url:'https://example.invalid/jobs/'+i}));
 const r=await collectRecovered({provider:'greenhouse',api_config:{board_token:'synthetic',mainland_location_pattern:'Beijing|Shanghai'}},{client:fakeClient(()=>({jobs,meta:{total:3}}))});assert.equal(r.jobs.length,2);assert.equal(r.coverage.excluded_location_rows.length,1);assert.equal(r.coverage.list_complete,true);assert.equal(r.coverage.status,'complete');assert.ok(r.jobs.some(j=>j.locations_raw[0].includes('Singapore')));
});
test('Ashby enumerates one anonymous board response without requesting job details',async()=>{
 const jobs=[{id:'a',title:'Engineer',descriptionPlain:body,location:'Shanghai',secondaryLocations:[],jobUrl:'https://jobs.ashbyhq.com/acme/a',employmentType:'FullTime',isListed:true}];
 const c=fakeClient(()=>({jobs}));
 const r=await collectRecovered({company_id:'acme',display_name:'Acme',provider:'ashby',api_config:{board_token:'acme'}},{client:c,mode:'list'});
 assert.equal(r.jobs.length,1);assert.equal(r.jobs[0].job_id,'a');assert.equal(r.coverage.list_complete,true);assert.equal(r.coverage.status,'complete');assert.equal(c.records.length,1);assert.equal(c.records[0].purpose,'job_list_with_full_content');
});
test('XYZ rejects a full JD belonging to a different tenant',async()=>{
 const c=fakeClient(q=>q.url.includes('get_customer_setting')?{result:'1',data:{ctmId:'synthetic-guid'}}:{result:'1',data:{total:1,records:[{jobId:'shared',ehireCtmId:'202',jobName:'工程师',jobInfo:body,jobAreas:'上海',isExpired:false}]}});
 const r=await collectXYZ({provider:'51job_xyz',api_config:{ehire_ctm_id:'101'}},{client:c,maxPages:1});assert.equal(r.jobs.length,0);assert.equal(r.coverage.status,'partial');assert.match(r.coverage.reason,/Tenant mismatch/);
});
