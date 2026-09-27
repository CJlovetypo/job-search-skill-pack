import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectAjinga} from '../../../../../shared/job-search-core/scripts/lib/provider-ajinga.mjs';
import {atsConfiguration} from '../../../../../shared/job-search-core/scripts/discover-waiqi-zero-websites.mjs';
import {publicListCandidateProblem} from '../../../../../shared/job-search-core/scripts/lib/public-list-source-policy.mjs';
const source={provider:'ajinga_public',company_id:'fixture',display_name:'Example',api_config:{company_id:'12',root_company_id:'10'}};
const job=(id,extra={})=>({pk:id,title:'Engineer',company:{root_pk:10,pk:15},cities:['Shanghai'],is_overseas:false,url:'/job-detail-new/'+id+'/c/',...extra});
const client=(pages,root=10)=>({records:[],async request({url}){
  assert.ok(!url.includes('job-detail'));
  const data=url.includes('/company/info/')?{code:200,data:{company:{id:12,root_company:{id:root,name:'Example'}}}}:{code:200,data:pages.shift()};
  assert.ok(data.data);return {data,record:{http_status:200,response_file:'fixture'}};
}});
test('AJINGA child channel uses verified profile root and enumerates unique pages without details',async()=>{
  const r=await collectAjinga(source,{mode:'list',client:client([{count:2,list:[job(1)]},{count:2,list:[job(2)]}])});
  assert.equal(r.coverage.status,'complete');assert.equal(r.jobs.length,2);assert.ok(r.jobs.every(j=>!j.body_complete));
});
test('AJINGA refuses changed tenant identity, mismatched rows, repeated pages and total drift',async()=>{
  for(const c of [client([],99),client([{count:1,list:[job(1,{company:{root_pk:99}})]}]),client([{count:2,list:[job(1)]},{count:2,list:[job(1)]}]),client([{count:2,list:[job(1)]},{count:3,list:[job(2)]}])]){
    const r=await collectAjinga(source,{mode:'list',maxPages:2,client:c});assert.notEqual(r.coverage.status,'complete');
  }
});
test('AJINGA excludes foreign and HK/TW rows even when overseas flag is false, and keeps unknown city incomplete',async()=>{
  const r=await collectAjinga(source,{mode:'list',client:client([{count:5,list:[job(1),job(2,{cities:['Hong Kong']}),job(3,{cities:['Taipei']}),job(4,{cities:['Seattle']}),job(5,{cities:[]})]}])});
  assert.deepEqual(r.jobs.map(j=>j.job_id),['1']);assert.equal(r.coverage.status,'partial');
});
test('AJINGA list-only evidence cannot claim full JD coverage, while a verified empty list is complete',async()=>{
  const r=await collectAjinga(source,{mode:'full',client:client([{count:1,list:[job(1)]}])});assert.equal(r.coverage.status,'partial');
  const z=await collectAjinga(source,{mode:'list',client:client([{count:0,list:[]}])});assert.equal(z.coverage.status,'complete');assert.equal(z.jobs.length,0);
});
test('AJINGA discovery recognizes company routes and does not mistake job ID for company ID',()=>{
  assert.equal(atsConfiguration('https://www.ajinga.com/recruiting/company/12/').api_config.company_id,'12');
  assert.equal(atsConfiguration('https://www.ajinga.com/job-detail-new/12/c/'),null);
});
test('AJINGA admission binds immutable anonymous list proof to the reviewed company and root',()=>{
  const c={provider:'ajinga_public',api_config:{company_id:'12',root_company_id:'10'},verification_status:'verified_public_list_only',admitted:true,identity_verification:{identity_verified:true,official_name:'Example',evidence_file:'fixture',basis:'Reviewed company profile'},source_verification:{complete_jd_samples:0,proof_directory:'fixture',identity_basis:'Reviewed company profile',observed_jobs:1,public_list_capability:{anonymous:true,list_complete:true,jobs_observed:1,company_profile:{company_id:'12',root_company_id:'10',root_company_name:'Example',http_status:200,anonymous_session_from_scratch:true,response_file:'fixture',response_sha256:'a'.repeat(64)},request_evidence:[{url:'https://www.ajinga.com/django_rest/job-list/?company_id=12&page=1',http_status:200,anonymous_session_from_scratch:true,response_file:'fixture',response_sha256:'b'.repeat(64)}]}}};
  assert.equal(publicListCandidateProblem(c),null);
  for(const change of [x=>x.api_config.root_company_id='99',x=>delete x.source_verification.public_list_capability.company_profile,x=>x.source_verification.public_list_capability.request_evidence[0].url='https://www.ajinga.com/django_rest/job-list/?company_id=99',x=>x.source_verification.public_list_capability.request_evidence[0].headers={Cookie:'private'}]){const copy=structuredClone(c);change(copy);assert.ok(publicListCandidateProblem(copy));}
});
