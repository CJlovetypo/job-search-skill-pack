import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {SKILL_ROOT,readJson,writeJson} from '../lib/io.mjs';
import {bindReview,createBatch,startBatch,submitBatch,mergeBatch,closeBatch,batchStatus} from '../lib/batches.mjs';
import {buildReportData,reviewNeedsUpdate} from '../lib/reports.mjs';
import {modeProfileProblem,v5EligibilityProblem,v5EligibilityFields} from '../../../../../shared/job-search-core/scripts/lib/search-mode.mjs';
import {allowLocationReview,modelVersion,v5DimensionsProblem,v5EvidenceProblem,v5ActionProblem} from '../../../../../shared/job-search-core/scripts/lib/assessment-v5.mjs';

const profile=()=>({assessment_model_version:5,evidence:[],city_filters:[],city_preference:{state:'unspecified',values:[],importance:'open'}});
const job=()=>({company_id:'v5-fixture',job_id:'1',title:'项目管理',description:'协调项目进度并跟进风险',requirements:'本科，2027届，专业不限',body_complete:true,formal_status:'formal',open_status:'open',evaluation_status:'to_assess',cities:['上海'],official_url:'https://example.com/jobs/1'});
function judgment(){return {
  review_method:'full_jd',ability:'unknown',ability_reason:'缺少本人排期与风险处理事实，不能判断。',interest:'unknown',interest_reason:'尚未提供工作内容偏好。',interest_checks:[],
  eligibility:'unknown',eligibility_reason:'JD有学历与届别要求，本人信息未提供。',eligibility_checks:v5EligibilityFields('campus').map(field=>({field,status:field==='major'?'not_stated':'unknown',jd_requirement:field==='major'?'专业不限':'本科/2027届',candidate_fact:'本人资料未提供'})),
  next_action:'clarify',conclusion:'信息待确认，可保留候选。',next_step:'补充排期与风险跟进案例及学历届别。',
  comparisons:[{jd_requirement:'排期与风险跟进',requirement_type:'core',status:'unknown',support:'unsupported',evidence_strength:'none',profile_evidence_ids:[],explanation:'没有提供对应实践，不等于不会。',gap:'本人行动与结果'}],
  city_check:{status:'unspecified',importance:'open',user_basis:'用户没有指定城市',job_basis:'JD工作城市上海'},
  salary_check:{status:'not_specified',raw:'',reason:'用户未指定，JD未披露',user_basis:'没有薪资偏好',job_basis:'测试JD未披露'},
  evidence_sufficiency:{status:'insufficient',reason:'缺少具体任务及学历届别事实',missing:['本人排期与风险跟进案例','学历及毕业时间']},
  report_summary:{conclusion:'资料不足，补资料后判断。',ability:'具体任务经历未知。',interest:'工作偏好未知。',gaps:'补充项目经历、学历和毕业时间。'}
};}
const checked=(p=profile(),r=judgment(),j=job())=>({p,j,r:bindReview({job:j},p,r)});
const fact={id:'E1',kind:'self_description',source:'合成用户自述',claim_type:'objective_experience',experience_type:'employment',experience_id:'EXP1',text:'本人有4年正式财务经验'};

test('v5 无简历、空证据是可交付的不确定；旧版本仍要求旧规则',()=>{
  const {p,j,r}=checked();assert.equal(reviewNeedsUpdate(r,j,p),null);assert.equal(modelVersion(p),5);assert.equal(modelVersion({}),4);
  r.assessment_version=4;assert.match(reviewNeedsUpdate(r,j,p),/版本/);
});
test('缺证不能判能力低、不能直接投递或暂不建议',()=>{
  for(const action of ['apply','prepare','hold']){const {p,j,r}=checked();r.next_action=action;assert.match(reviewNeedsUpdate(r,j,p),/补资料/);}
  const r=judgment();r.ability='low';assert.match(v5EvidenceProblem(r,profile()),/核心要求冲突/);
  r.comparisons[0].status='conflict';assert.match(v5EvidenceProblem(r,profile()),/本人具体事实/);
});
test('确证不符需真实个人事实；不能把自评偏好当负面事实',()=>{
  const p=profile(),r=judgment();r.ability='low';r.comparisons[0].status='conflict';r.comparisons[0].profile_evidence_ids=['E1'];
  p.evidence=[fact];assert.equal(v5EvidenceProblem(r,p),null);
  p.evidence=[{...fact,claim_type:'preference'}];assert.match(v5EvidenceProblem(r,p),/本人具体事实/);
});
test('年限差距不否决，必须保留差距及放宽依据，学历和专业分开',()=>{
  const p={...profile(),evidence:[fact],employment_years:4};
  const r={eligibility:'eligible',eligibility_checks:v5EligibilityFields('social').map(field=>({field,status:'not_stated',jd_requirement:'JD无要求',candidate_fact:'未提供'}))};
  const years=r.eligibility_checks.find(x=>x.field==='employment_years');Object.assign(years,{status:'partial',jd_requirement:'至少6年',candidate_fact:'4年，相差2年',flexibility:{status:'uncertain',reason:'未提供同等责任/成果，能否放宽未知',evidence_ids:['E1']}});
  assert.equal(v5EligibilityProblem(r,p,'social'),null);
  years.status='conflict';assert.match(v5EligibilityProblem(r,p,'social'),/自动否决/);years.status='partial';
  years.flexibility={status:'supported',reason:'有放宽依据',evidence_ids:[]};assert.match(v5EligibilityProblem(r,p,'social'),/实际职责/);
  years.flexibility={status:'not_needed',reason:'假装满足',evidence_ids:['E1']};assert.match(v5EligibilityProblem(r,p,'social'),/无需放宽/);
  years.flexibility={status:'uncertain',reason:'具体任务缺失',evidence_ids:[]};
  const major=r.eligibility_checks.find(x=>x.field==='major');major.status='unknown';r.eligibility='unknown';assert.equal(v5EligibilityProblem(r,p,'social'),null);
  major.status='conflict';assert.match(v5EligibilityProblem(r,p,'social'),/已知个人事实/);
});
test('城市未指定、明确不限、未知和硬冲突分开；不能变更偏好权重',()=>{
  const p=profile(),r=judgment(),j=job();assert.equal(v5DimensionsProblem(r,p,j),null);
  p.city_preference={state:'explicit',values:[],importance:'open'};assert.match(v5DimensionsProblem(r,p,j),/不限制/);r.city_check.status='unrestricted';assert.equal(v5DimensionsProblem(r,p,j),null);
  p.city_preference={state:'explicit',values:['上海'],importance:'must'};r.city_check={...r.city_check,status:'unknown',importance:'must'};assert.equal(v5DimensionsProblem(r,p,{...j,cities:[]}),null);
  r.city_check.status='met';assert.match(v5DimensionsProblem(r,p,{...j,cities:[]}),/城市.*证据/);
  r.city_check.importance='prefer';assert.match(v5DimensionsProblem(r,p,j),/重要性/);
});
test('薪资参考未知不改变主要动作，缺原值不允许比较，无偏好不创设目标',()=>{
  const p=profile(),r=judgment();r.salary_check.status='gap';assert.match(v5DimensionsProblem(r,p,job()),/原值/);
  r.salary_check.raw='20k';assert.match(v5DimensionsProblem(r,p,job()),/没有薪资偏好/);
  p.salary_preference='年薪30万';r.salary_check.status='unknown';assert.equal(v5DimensionsProblem(r,p,job()),null);
  Object.assign(r,{assessment_version:5,ability:'high',interest:'aligned',eligibility:'eligible',next_action:'apply'});assert.equal(v5ActionProblem(r),null);r.salary_check.status='gap';assert.equal(v5ActionProblem(r),null);
});
test('城市、薪资不重复计入工作意愿；软偏好不升级否决',()=>{
  const r=judgment();r.interest_checks=[{dimension:'salary'}];assert.match(v5DimensionsProblem(r,profile(),job()),/单列/);
  r.interest_checks=[{dimension:'role',importance:'prefer',status:'conflict'}];r.interest='conflict';assert.match(v5DimensionsProblem(r,profile(),job()),/软偏好/);
});
test('完整JD只缺地点可审阅，其他采集疑点保持待核实',()=>{
  const data={jobs:[{...job(),evaluation_status:'needs_verification',verification_issues:[{code:'location'}]},{...job(),evaluation_status:'needs_verification',verification_issues:[{code:'location'},{code:'body'}]}],counts:{}};
  const result=allowLocationReview(data,profile());assert.equal(result.jobs[0].evaluation_status,'to_assess');assert.equal(result.jobs[0].location_review_pending,true);assert.equal(result.jobs[1].evaluation_status,'needs_verification');assert.equal(result.counts.to_assess,1);
});
test('未知画像放行但已提供的非法年限和实习安排仍拒绝',()=>{
  assert.equal(modeProfileProblem(profile(),'social'),null);
  assert.match(modeProfileProblem({...profile(),employment_years:-1},'social'),/非负/);
  assert.match(modeProfileProblem({...profile(),internship_availability:{days_per_week:8}},'internship'),/天数/);
});
test('核心未知/部分符合不评高，充分性不能伪称充分',()=>{
  const p={...profile(),evidence:[fact]},r=judgment();r.ability='high';assert.match(v5EvidenceProblem(r,p),/决定性核心/);
  Object.assign(r.comparisons[0],{status:'partial',support:'direct',profile_evidence_ids:['E1']});assert.match(v5EvidenceProblem(r,p),/部分符合/);
  r.ability='unknown';r.evidence_sufficiency.status='sufficient';assert.match(v5EvidenceProblem(r,p),/具体缺项/);
});
test('不确定可以submit→merge→交付15列，续跑不反复领取；JD变更需重评',async()=>{
  await fs.mkdir(path.join(SKILL_ROOT,'tmp'),{recursive:true});
  const dir=await fs.mkdtemp(path.join(SKILL_ROOT,'tmp','v5-'));const p=profile(),j=job();
  const company={company_id:j.company_id,display_name:'合成v5公司',selected:true,business_tags:['软件'],ownership_tag:'私企',ownership_status:'verified',ownership_reason:'合成来源',ownership_evidence:[{url:'https://example.com',title:'合成',note:'合成',checked_at:'2026-09-22'}],ownership_checked_at:'2026-09-22'};
  await writeJson(path.join(dir,'run.json'),{is_test:true,profile:p,companies:[company]});
  await writeJson(path.join(dir,'companies',j.company_id+'.json'),{jobs:[j],coverage:{status:'complete'},counts:{to_assess:1},checked_at:'2026-09-22'});
  await writeJson(path.join(dir,'evaluation-scope.json'),{mode:'all',company_ids:[j.company_id],confirmed_at:'2026-09-22',user_request:'合成测试'});
  const b=await createBatch(dir,{limit:10}),input=await readJson(b.input);assert.match(input.assessment_instruction,/缺证/);
  await startBatch(dir,b.batch_id,'test-v5');const submitted=await submitBatch(dir,b.batch_id,'test-v5',[{key:input.items[0].key,review:judgment()}]);assert.deepEqual(submitted.errors,{});
  assert.equal((await mergeBatch(dir,b.batch_id)).added,1);await closeBatch(dir,b.batch_id,{agentId:'test-v5',stopped:true});assert.equal((await batchStatus(dir)).done,1);
  const report=await buildReportData(dir);assert.equal(report.audit.complete_evaluation_scope,true);assert.equal(report.audit.reviewed_with_uncertainty,1);assert.equal(report.sheets.length,4);assert.equal(report.sheets[0].headers.length,15);assert.equal(report.sheets[0].rows[0].length,15);assert.equal(report.sheets[0].rows[0][4],'补资料后判断');assert.equal(report.sheets[0].rows[0][8],'不确定');assert.match(report.sheets[0].rows[0][13],/仅供参考/);
  const next=await createBatch(dir);assert.equal(next.items,0);
  const saved=(await readJson(path.join(dir,'assessments',j.company_id+'.json'))).assessments[0];assert.match(reviewNeedsUpdate(saved,{...j,requirements:'新JD要求'},p),/JD更新/);
});
