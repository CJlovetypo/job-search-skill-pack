import './context.mjs';
import test from'node:test';import assert from'node:assert/strict';
import{collectLightbolt,normalizeLightboltJob}from'../lib/provider-lightbolt.mjs';
import{extractRawBody}from'../lib/body-review.mjs';
test('LightBolt raw body extraction uses exact JobAdId and actual structured fields',()=>{
 const raw={Code:200,Data:{JobAdId:123,DutyStr:'<p>负责软件开发与测试。</p>',RequireStr:'本科及以上学历，熟悉开发流程。'}};
 const matched=extractRawBody(raw,'123');assert.equal(matched.description,'负责软件开发与测试。');assert.equal(matched.requirements,'本科及以上学历，熟悉开发流程。');assert.deepEqual(matched.fields,['DutyStr','RequireStr']);assert.equal(extractRawBody(raw,'999').error,'no_exact_id_record');
});
const source={company_id:'fixture',display_name:'测试租户',primary_entry_url:'https://fixture.m.zhiye.com/',api_config:{categories:[2,3]}};
const row=(id,category=2,city='上海市')=>({JobAdId:id,JobAdName:'研发工程师',CategoryId:category,KindId:category===3?2:1,LocIdName:city,Duty:'负责智能控制软件开发，参与技术方案设计和测试验证。'});
const detail=(id,category=2)=>({...row(id,category),Kind:category===3?2:1,DutyStr:'负责智能控制软件开发，参与技术方案设计和测试验证。',RequireStr:'本科及以上学历，计算机相关专业，熟悉软件开发流程。'});
function client(handler){return{records:[],async request(q){const u=new URL(q.url);this.records.push(q);if(u.pathname==='/')return{text:'BSGlobal.TenantId = 123;',record:{http_status:200}};const data=handler(u);return{data,record:{http_status:200},text:JSON.stringify(data)};}};}
test('normal full collection paginates all configured categories after a complete JD',async()=>{
const c=client(u=>{if(u.pathname.endsWith('/Info'))return{Code:200,Data:detail(Number(u.searchParams.get('adid')),u.searchParams.get('adid')==='3'?3:2)};const jc=Number(u.searchParams.get('jc')),page=Number(u.searchParams.get('pi'));return{Code:200,Data:{data:{RowCount:jc===2?2:1,DataResult:[row(jc===3?3:page,jc)]}}};});
const r=await collectLightbolt(source,{client:c,mode:'full',pageSize:1,maxPages:3});assert.equal(r.jobs.length,3);assert.equal(r.coverage.status,'complete');assert.equal(r.coverage.pages,3);assert.deepEqual(r.coverage.unqueried_categories,[]);assert.equal(r.jobs.find(j=>j.job_id==='3').formal_status,'internship');
});
test('capability shortcut is explicit and cannot claim complete category coverage',async()=>{
const c=client(u=>u.pathname.endsWith('/Info')?{Code:200,Data:detail(1)}:{Code:200,Data:{data:{RowCount:1,DataResult:[row(1)]}}});const r=await collectLightbolt(source,{client:c,mode:'full',capabilityOnly:true});assert.equal(r.coverage.status,'partial');assert.deepEqual(r.coverage.unqueried_categories,[3]);assert.equal(r.jobs.length,1);
});
test('list mode does not fetch details; full detail mismatch preserves list record and failure',async()=>{
const c=client(u=>u.pathname.endsWith('/Info')?{Code:200,Data:detail(999)}:{Code:200,Data:{data:{RowCount:1,DataResult:[row(1)]}}});const r=await collectLightbolt({...source,api_config:{categories:[2]}},{client:c,mode:'list'});assert.equal(c.records.filter(q=>q.url.includes('/Info?')).length,0);assert.deepEqual(r.jobs[0].cities,['上海']);assert.equal(r.jobs[0].body_complete,false);
const full=await collectLightbolt({...source,api_config:{categories:[2]}},{client:c,mode:'full'});assert.equal(full.jobs.length,1);assert.equal(full.jobs[0].job_id,'1');assert.match(full.jobs[0].detail_error,/does not match/);assert.equal(full.coverage.status,'partial');assert.equal(full.coverage.details_failed,1);
});
test('repeated pages cannot reconcile total; city exclusions skip only detail retrieval',async()=>{
const c=client(u=>{assert.ok(!u.pathname.endsWith('/Info'));return{Code:200,Data:{data:{RowCount:3,DataResult:[row(1,2,'北京市')]}}};});const r=await collectLightbolt({...source,api_config:{categories:[2]}},{client:c,mode:'full',pageSize:1,maxPages:3,cityFilters:['上海']});assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.pages,2);assert.equal(r.jobs[0].detail_skipped_reason,'explicit_non_target_city');assert.equal(r.coverage.details_skipped_city,1);
});
test('unknown category stays unknown and expired deadline stays closed',()=>{const j=normalizeLightboltJob({source,row:{...row(1),CategoryId:undefined,ToEndDate:'2020-01-01'},checkedAt:'2026-09-17T00:00:00Z',category:2});assert.equal(j.formal_status,'unknown');assert.equal(j.open_status,'closed');assert.match(j.official_url,/JobAd\/Info\?adid=1$/);});
test('changing totals and duplicate IDs remain partial even if final unique count reconciles',async()=>{
const c=client(u=>{const p=Number(u.searchParams.get('pi'));return{Code:200,Data:{data:{RowCount:p===1?4:3,DataResult:p===1?[row(1),row(2)]:[row(2),row(3)]}}};});const r=await collectLightbolt({...source,api_config:{categories:[2]}},{client:c,mode:'list',pageSize:2,maxPages:3});assert.equal(r.jobs.length,3);assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.list_complete,false);assert.match(r.coverage.reason,/server_total_changed/);assert.match(r.coverage.reason,/duplicate_job_ids/);
});
test('successful detail with no duties does not claim full body coverage',async()=>{
const c=client(u=>u.pathname.endsWith('/Info')?{Code:200,Data:{JobAdId:1,RequireStr:'本科及以上学历，计算机相关专业。'}}:{Code:200,Data:{data:{RowCount:1,DataResult:[{...row(1),Duty:''}]}}});const r=await collectLightbolt({...source,api_config:{categories:[2]}},{client:c,mode:'full'});assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.list_complete,true);assert.equal(r.coverage.details_incomplete,1);assert.equal(r.jobs[0].body_complete,false);
});
