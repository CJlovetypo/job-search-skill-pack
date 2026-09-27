import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {keywordRequestProof,keywordNegativeComplete} from '../../../../../shared/job-search-core/scripts/lib/keyword-audit-proof.mjs';

const response=(keyword,overrides={})=>({requests:[{purpose:'job_list',http_status:200,method:'POST',url:'https://example.org/jobs',body:{keyword,siteId:1,offset:0},...overrides}]});
const check=(b=response(''),p=response('Engineer'),n=response('zzAbsent'))=>keywordRequestProof('moka',b,p,n,'Engineer','zzAbsent');
test('Huatie GET proof preserves channel and status filters while ignoring only keyword and page',()=>{
 const r=(keyword,page=1,source=2)=>({requests:[{purpose:'public_job_list_with_full_bodies',http_status:200,method:'GET',url:'https://production-api.dahuangf.com/api/htwww/job/list?'+new URLSearchParams({keywords:keyword,current:String(page),source:String(source),status:'1',size:'10'})}]});
 assert.deepEqual(keywordRequestProof('huatie_public',r(''),r('Engineer',2),r('absent'),'Engineer','absent'),{keyword_sent:true,same_list_routes:true});
 assert.equal(keywordRequestProof('huatie_public',r(''),r('Engineer'),r('absent',1,1),'Engineer','absent').same_list_routes,false);
 assert.equal(keywordRequestProof('huatie_public',r(''),r('Engineer'),r(''),'Engineer','absent').keyword_sent,false);
});

test('Workday empty location queries prove keyword completion without claiming country-wide coverage',()=>{
 const value={jobs:[],coverage:{status:'partial',list_complete:true,location_filter:[{field:'locations',values:[{id:'SH'}],list_complete:true,server_total:0}],page_evidence:[{query_field:'locations',server_total:0,job_ids:[]}]},requests:[{purpose:'location_filtered_job_list',http_status:200,body:{appliedFacets:{locations:['SH']}}}]};
 assert.equal(keywordNegativeComplete('workday',value),true);assert.equal(value.coverage.status,'partial');
 for(const change of [r=>{r.coverage.location_filter=[]},r=>{r.coverage.page_evidence=[]},r=>{r.requests=[]},r=>{r.requests[0].http_status=500},r=>{r.requests[0].body.appliedFacets.locations=['BJ']},r=>{r.coverage.location_filter[0].list_complete=false},r=>{r.coverage.direction={limitation:'social site missing'}},r=>{r.coverage.page_evidence[0].server_total=1},r=>{r.jobs=[{job_id:'unexpected'}]}]){
  const broken=structuredClone(value);change(broken);assert.equal(keywordNegativeComplete('workday',broken),false);
 }
 assert.equal(keywordNegativeComplete('moka',value),false);
});

test('audit accepts keywords sent successfully to the same list route',()=>{
 assert.deepEqual(check(),{keyword_sent:true,same_list_routes:true});
});
test('audit rejects missing, failed or ignored keyword requests',()=>{
 for(const negative of [{requests:[]},response('zzAbsent',{http_status:403}),response('')])assert.equal(check(undefined,undefined,negative).keyword_sent,false);
});
test('audit rejects route drift even when the negative result is empty',()=>{
 assert.equal(check(undefined,undefined,response('zzAbsent',{url:'https://example.org/other'})).same_list_routes,false);
 assert.equal(check(undefined,undefined,response('zzAbsent',{body:{keyword:'zzAbsent',siteId:2,offset:0}})).same_list_routes,false);
});
test('audit rejects portal header drift and ignores fresh anti-CSRF headers',()=>{
 const headers={'website-path':'campus','portal-channel':'office','x-csrf-token':'old'};
 const b=response('',{headers}),p=response('Engineer',{headers:{'Website-Path':'campus','Portal-Channel':'office','X-Csrf-Token':'fresh'}});
 assert.equal(check(b,p,response('zzAbsent',{headers})).same_list_routes,true);
 assert.equal(check(b,p,response('zzAbsent',{headers:{...headers,'website-path':'social'}})).same_list_routes,false);
 assert.equal(check(b,p,response('zzAbsent',{headers:{...headers,'portal-channel':'public'}})).same_list_routes,false);
});
test('audit ignores pagination and body key order when comparing routes',()=>{
 assert.equal(check(undefined,response('Engineer',{body:{offset:20,siteId:1,keyword:'Engineer'}})).same_list_routes,true);
});
test('XYZ proof allows per-query signatures but preserves employer identity',()=>{
 const result=(keyWord,ctmId='employer')=>({requests:[{purpose:'job_list_with_full_JD',http_status:200,url:'https://xyzapij.51job.com/position-domain/consumer/noauth/get_job_list',method:'POST',body:{keyWord,ctmId,pageIndex:1,timestamp:123,sign:'signature-'+keyWord}}]});
 const proof=ctmId=>keywordRequestProof('51job_xyz',result(''),result('Engineer'),result('zzAbsent',ctmId),'Engineer','zzAbsent');
 assert.deepEqual(proof('employer'),{keyword_sent:true,same_list_routes:true});
 assert.equal(proof('another-employer').same_list_routes,false);
});

test('missing direction is retained while a completed query can prove its keyword filter',()=>{
 const r={jobs:[],coverage:{status:'partial',collection_complete:true,direction:{limitation:'social portal missing'},contexts:[{status:'complete',list_complete:true,server_total:0,page_evidence:[{server_total:0,job_ids:[]}]}]}};
 assert.equal(keywordNegativeComplete('moka',r),true);assert.equal(keywordNegativeComplete('feishu',r),true);assert.equal(r.coverage.direction.limitation,'social portal missing');
 for(const change of [r=>r.coverage.collection_complete=false,r=>r.coverage.contexts=[],r=>r.coverage.contexts[0].list_complete=false,r=>r.coverage.contexts[0].server_total=null,r=>r.coverage.contexts[0].page_evidence=[],r=>r.coverage.contexts[0].page_evidence[0].job_ids=['unexpected']]){const bad=structuredClone(r);change(bad);assert.equal(keywordNegativeComplete('moka',bad),false);}
});
