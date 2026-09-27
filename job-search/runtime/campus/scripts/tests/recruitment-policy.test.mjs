import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewRecruitment,restoreRequestRecruitmentEvidence} from '../lib/recruitment-policy.mjs';
const job = (e,extra={}) => ({title:'项目经理',formal_status:'unknown',open_status:'open',recruitment_evidence:e,...extra});
test('旧快照只用精确响应文件恢复实际校招请求枚举，不借用其他响应或多类型查询',()=>{
 const original=job({provider:'feishu'},{raw_file:'C:\\test\\one.json'});
 const request={url:'https://example.com/api/v1/search/job/posts',response_file:'C:/test/one.json',http_status:200,body:{recruitment_id_list:['201']}};
 const restored=restoreRequestRecruitmentEvidence(original,[request]);
 assert.equal(reviewRecruitment(restored).formal_status,'formal');
 assert.equal(original.recruitment_evidence.query_recruitment_id_list,undefined);
 for(const changed of [{...request,response_file:'C:/test/two.json'},{...request,http_status:500},{...request,body:{recruitment_id_list:['201','202']}}])assert.equal(reviewRecruitment(restoreRequestRecruitmentEvidence(original,[changed])).formal_status,'unknown');
});
test('接口校招类型无需独立全职字段',()=>{
  const result=reviewRecruitment(job({provider:'beisen',Category:'校园招聘',Kind:''}));
  assert.equal(result.formal_status,'formal');
  assert.ok(result.recruitment_evidence.admission_review.evidence.some(e=>e.field.endsWith('Category')));
});
test('关联校招项目或明确校招接口枚举即可确认',()=>{
  for(const e of [{provider:'moka',projectFolder:{name:'2027届秋季校招'}},{provider:'moka',hireMode:2,showIsCampus:false},{provider:'hotjob',recruitType:1,projectName:'日常招聘'},{provider:'feishu',recruit_type:{id:201}},{query_recruitType:'GRADUATE'}])assert.equal(reviewRecruitment(job(e)).formal_status,'formal');
});
test('全职或仅校招入口不能代替单岗位校招证据',()=>{
  assert.equal(reviewRecruitment(job({provider:'amazon_jobs',job_schedule_type:'full-time'})).formal_status,'unknown');
  assert.equal(reviewRecruitment(job({provider:'feishu',campus_context:true})).formal_status,'unknown');
});
test('明确社招标题不能被校园频道或旧formal状态覆盖',()=>{
 for(const title of ['社招-Analog Engineer','【社招】研发工程师','工程师（社会招聘）']) {
  assert.equal(reviewRecruitment(job({provider:'moka',hireMode:2},{title,formal_status:'formal'})).formal_status,'unknown');
  assert.equal(reviewRecruitment(job({},{title})).formal_status,'social');
 }
 assert.equal(reviewRecruitment(job({provider:'moka',hireMode:2},{title:'校招-软件开发',requirements:'需提前实习三个月'})).formal_status,'formal');
});
test('保留明确实习社招和实际类型冲突，提前实习要求不改变正式性质',()=>{
  assert.equal(reviewRecruitment(job({Category:'校园招聘'}, {formal_status:'internship'})).formal_status,'internship');
  assert.equal(reviewRecruitment(job({Category:'校园招聘'}, {formal_status:'social'})).formal_status,'social');
  assert.equal(reviewRecruitment(job({provider:'moka',hireMode:2,commitment:'实习',type_conflict:{explicit_body_statement:'正式岗'}})).formal_status,'unknown');
  assert.equal(reviewRecruitment(job({Category:'校园招聘'}, {title:'项目经理（需提前实习）',requirements:'提前实习三个月'})).formal_status,'formal');
});
test('校园活动和兼职明确记为不纳入，而不是无限待核实',()=>{
  assert.equal(reviewRecruitment(job({Category:'校园招聘'},{title:'校园大使'})).formal_status,'activity');
  assert.equal(reviewRecruitment(job({Category:'校园招聘',Kind:'兼职'})).formal_status,'parttime');
});
