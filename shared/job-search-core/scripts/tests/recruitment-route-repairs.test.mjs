import test from 'node:test';
import assert from 'node:assert/strict';
import {collectHuawei} from '../lib/provider-huawei.mjs';
import {reviewRecruitment} from '../lib/recruitment-policy.mjs';
import {targetApiProof} from '../lib/target-api-proof.mjs';
import {assertWorkdayDetailIdentity,isWorkdayMainlandDetail} from '../lib/providers-international.mjs';

test('Huawei SR uses list JD; CR shares campus/internship and respects detail limit',async()=>{
 const source={company_id:'test',display_name:'Test',provider:'huawei'};
 for(const mode of ['social','campus','internship']){
  const calls=[],client={records:[],async request(q,meta){calls.push(q);return {record:{http_status:200,response_file:'synthetic'},data:q.url.includes('getJobPage')?{status:'SUCCESS',data:{pageVO:{totalRows:1},result:[{advertisementId:1,jobId:2,jobType:'1',scenarioName:mode==='social'?null:'实习生',jobName:'软件工程师',mainBusiness:'负责软件开发与系统维护，参与设计和测试工作。',jobRequire:'计算机相关专业本科以上，熟悉软件开发及系统设计。'}]}}:{status:'SUCCESS',data:[]}};}};
  const result=await collectHuawei(source,{targetMode:mode,client,maxDetails:0,pageSize:10});
  assert.equal(calls[0].body.jobType,mode==='social'?'SR':'CR');assert.equal(calls.length,1);
  assert.equal(result.coverage.list_complete,true);assert.deepEqual(result.coverage.page_evidence[0].job_ids,['1']);
  const job=reviewRecruitment(result.jobs[0],mode);
  assert.equal(job.formal_status,mode==='social'?'social':'internship');
  assert.equal(targetApiProof(job,source,mode==='social'?'social':'internship').accepted,true);
 }
});
test('Workday missing requisition uses exact same employer site/path, never a foreign or different job URL',()=>{
 const source={api_config:{origin:'https://fixture.myworkdayjobs.com',site:'Careers'}};
 const row={externalPath:'/job/Shanghai/Engineer_'};
 const info={id:'internal-uuid',jobReqId:'',externalUrl:'https://fixture.myworkdayjobs.com/Careers/job/Shanghai/Engineer_'};
 assert.doesNotThrow(()=>assertWorkdayDetailIdentity(row,{jobPostingInfo:info},source));
 for(const externalUrl of ['https://other.myworkdayjobs.com/Careers/job/Shanghai/Engineer_','https://fixture.myworkdayjobs.com/Other/job/Shanghai/Engineer_','https://fixture.myworkdayjobs.com/Careers/job/Shanghai/Different_'])assert.throws(()=>assertWorkdayDetailIdentity(row,{jobPostingInfo:{...info,externalUrl}},source),/mismatch/);
 assert.throws(()=>assertWorkdayDetailIdentity(row,{jobPostingInfo:{...info,jobReqId:'DIFFERENT'}},source),/mismatch/);
});
test('Huawei shared student stream spends internship detail sample on observed interns',async()=>{
 const requested=[],client={records:[],async request(q){if(q.url.includes('getJobPage'))return {record:{http_status:200,response_file:'list'},data:{status:'SUCCESS',data:{pageVO:{totalRows:2},result:[{advertisementId:1,jobId:11,jobName:'A',scenarioName:'应届生'},{advertisementId:2,jobId:22,jobName:'B',scenarioName:'实习生'}]}}};requested.push(q.body.jobId);return {record:{http_status:200,response_file:'detail'},data:{status:'SUCCESS',data:[]}};}};
 await collectHuawei({company_id:'test',provider:'huawei'},{targetMode:'internship',maxDetails:1,client});assert.deepEqual(requested,[22]);
});
test('Workday additional mainland location needs structured location plus observed mainland filter',()=>{
 const make=loc=>({jobPostingInfo:{country:{descriptor:'Singapore'},additionalLocations:[loc]}});
 for(const loc of ['Shanghai','Shanghai, CHN','Beijing, CN']){
  assert.equal(isWorkdayMainlandDetail(make(loc)),false);
  assert.equal(isWorkdayMainlandDetail(make(loc),{mainlandFilterConfirmed:true}),true);
 }
 for(const loc of ['Hong Kong','Taipei, TWN','China business','London','Shanghai business team'])assert.equal(isWorkdayMainlandDetail(make(loc),{mainlandFilterConfirmed:true}),false);
});

import {bodyFetch} from '../lib/body-fetch.mjs';
test('inline full-content list records acquisition independently of section review',()=>{
 const job={description:'Returned job content',raw_file:'synthetic'};
 for(const purpose of ['job_list_with_full_content','job_list_and_full_jd'])assert.equal(bodyFetch(job,[{purpose,response_file:'synthetic',http_status:200,response_is_json:true}]).status,'available');
 assert.equal(bodyFetch(job,[{purpose:'job_list',response_file:'synthetic',http_status:200,response_is_json:true}]).status,'unknown');
});
