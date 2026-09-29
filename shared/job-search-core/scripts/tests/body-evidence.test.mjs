import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BODY_REVIEW_VERSION,reviewJobBody,extractRawBody} from '../lib/body-review.mjs';
import {bodyCacheReusable,needsBodyFetch} from '../lib/body-fetch.mjs';
import {jobFingerprint} from '../lib/job-version.mjs';
const body='岗位职责：\n负责产品研发。\n任职要求：\n熟悉 Java。';
const job={job_id:'1',company_id:'a',description:body,requirements:'',body_fetch:{status:'available',origin:'detail',reason:'fixture_official_body'}};
test('body review is idempotent and rejects a legacy true without acquisition evidence',()=>{
 const once=reviewJobBody(job),twice=reviewJobBody(once);
 assert(once.body_complete);assert.deepEqual(twice,once);
 const legacy=reviewJobBody({job_id:'1',description:body,body_complete:true});
 assert.equal(legacy.body_complete,false);assert.equal(legacy.body_fetch.status,'unknown');
 assert.equal(legacy.body_review.sections.requirements,'identified');
});
test('available duties without recognized qualifications do not cause refetch',()=>{
 const j=reviewJobBody({...job,description:'What you will do\nBuild reliable systems.'});
 assert.equal(j.body_complete,false);assert.equal(j.body_review.sections.requirements,'not_identified');
 assert.equal(needsBodyFetch(j),false);assert(bodyCacheReusable({coverage:{status:'partial',list_complete:true},jobs:[j]}));
 assert.equal(bodyCacheReusable({coverage:{status:'partial'},jobs:[j]}),false);
});
test('summary, budget and identity errors cannot be promoted by content',()=>{
 for(const [extra,status] of [[{body_is_summary:true},'partial'],[{body_fetch:undefined,detail_skipped_reason:'detail_limit'},'not_attempted'],[{detail_error:'ID mismatch'},'failed']]){
  const j=reviewJobBody({...job,...extra});assert.equal(j.body_complete,false);assert.equal(j.body_fetch.status,status);
 }
 const j=reviewJobBody({...job,body_fetch:undefined,raw_file:'fixture-detail.json'},{requests:[{purpose:'job_detail',http_status:200,response_is_json:true,response_file:'fixture-detail.json'}]});
 assert.equal(j.body_fetch.status,'available');assert(j.body_complete);
});
test('old manual method names do not bypass review; parser version invalidates assessment',()=>{
 const j=reviewJobBody({...job,description:'公司介绍：欢迎加入',requirements:'',body_complete:true,body_review:{method:'manual_full_record_review'}});
 assert.equal(j.body_complete,false);
 const a=reviewJobBody(job);assert.notEqual(jobFingerprint(a),jobFingerprint({...a,body_review:{...a.body_review,version:BODY_REVIEW_VERSION+1}}));
 assert.equal(jobFingerprint(a),jobFingerprint({...a,body_review:{...a.body_review,input_sha256:'different response metadata'}}));
});
test('explicit full-body list evidence remains available without relying on legacy true',()=>{
 const j={job_id:'1',description:body,evidence_files:['list.json'],detail_skipped_reason:'detail_limit'};
 const requests=[{purpose:'list_with_full_job_bodies',http_status:200,response_is_json:true,response_file:'list.json'}];
 assert.equal(reviewJobBody(j,{requests}).body_fetch.status,'available');
 assert.equal(reviewJobBody(j,{requests:[{...requests[0],purpose:'job_list'}]}).body_fetch.status,'not_attempted');
});
test('archived JSONP full body requires exact ID and is never executed',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'body-jsonp-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const raw=path.join(dir,'raw.txt');
 await fs.writeFile(raw,'jsoncallback('+JSON.stringify({resultbody:{jobid:'1',jobinfo:body}})+');');
 assert.equal(reviewJobBody({job_id:'1',raw_file:raw}).body_complete,true);
 assert.equal(reviewJobBody({job_id:'2',raw_file:raw}).body_complete,false);
 await fs.writeFile(raw,'jsoncallback({});globalThis.untrusted=true;');
 assert.equal(reviewJobBody({job_id:'1',raw_file:raw}).body_complete,false);assert.equal(globalThis.untrusted,undefined);
});

async function archive(t, records) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'body-evidence-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 return Promise.all(records.map(async (record,i)=>{
  const file=path.join(dir,`${i}.json`);await fs.writeFile(file,JSON.stringify(record));return file;
 }));
}

test('archived platform bodies support their original IDs and field names',async t=>{
 const duty='负责产品研发。',req='熟悉 Java。';
 const records=[
  {id:'1',positionDescription:body},
  {publishId:'1',workContent:duty,qualification:req},
  {id:'1',jobDuties:duty,jobRequirement:req},
  {jobUnionId:'1',jobDuty:duty,jobRequirement:req},
  {id:'1',postDuty:duty,jobRequirement:req},
  {id:'1',positionDescription:duty,positionRequirement:req},
  {pkId:'1',introduce:body},
 ];
 const files=await archive(t,records.map(r=>({data:{rows:[r]}})));
 for(const file of files){
  const reviewed=reviewJobBody({job_id:'1',evidence_files:[file]});
  assert.equal(reviewed.body_complete,true,file);
  assert.equal(reviewed.body_fetch.reason,'exact_id_official_body_fields');
  assert.equal(reviewed.body_review.sources[0].pointer,'/data/rows/0');
  assert.equal(reviewJobBody({job_id:'2',evidence_files:[file]}).body_complete,false);
 }
 assert.equal(extractRawBody({rows:[records[0],records[0]]},'1').error,'ambiguous_exact_id_records');
 assert.equal(extractRawBody({pkId:9007199254740992,introduce:body},'9007199254740992').error,'no_exact_id_record');
});

test('split legacy body is preserved without duplicating the archived whole body',async t=>{
 const [file]=await archive(t,[{id:'1',positionDescription:body}]);
 const original={job_id:'1',description:'岗位职责：\n负责产品研发。',requirements:'任职要求：\n熟悉 Java。'};
 const reviewed=reviewJobBody({...original,evidence_files:[file]});
 assert.equal(reviewed.description,original.description);assert.equal(reviewed.requirements,original.requirements);
 assert.deepEqual(reviewJobBody(reviewed),reviewed);
 assert.equal(reviewed.body_content_fingerprint,reviewJobBody({...original,body_fetch:job.body_fetch}).body_content_fingerprint);
});

test('Huawei intention requires matching advertisement, parent job and intention',async t=>{
 const files=await archive(t,[{data:{result:[{advertisementId:10,jobId:20}]}},{data:[{positionIntentionId:30,jobId:20,jobResponsibilities:'负责产品研发。',jobDemand:'熟悉 Java。'}]}]);
 const original={job_id:'10:30',evidence_files:files,recruitment_evidence:{provider:'huawei',advertisement_id:10,job_id:20,position_intention_id:30}};
 assert.equal(reviewJobBody(original).body_complete,true);
 for(const altered of [
  {evidence_files:[files[1]]},
  {job_id:'11:30',recruitment_evidence:{...original.recruitment_evidence,advertisement_id:11}},
  {job_id:'10:31',recruitment_evidence:{...original.recruitment_evidence,position_intention_id:31}},
  {recruitment_evidence:{...original.recruitment_evidence,job_id:21}},
 ])assert.equal(reviewJobBody({...original,...altered}).body_complete,false);
});

test('Yokaverse compound ID keeps companies with the same position number separate',async t=>{
 const [file]=await archive(t,[{rows:[{company:'alpha',position_id:3,description:body},{company:'beta',position_id:3,description:'公司介绍：欢迎加入'}]}]);
 const original={provider:'yokaverse',raw_file:file};
 assert.equal(reviewJobBody({...original,job_id:'alpha-3'}).body_complete,true);
 assert.equal(reviewJobBody({...original,job_id:'beta-3'}).body_complete,false);
 assert.equal(reviewJobBody({...original,job_id:'gamma-3'}).body_complete,false);
});

test('archived full list body survives a detail budget but cannot override summary or failed identity',async t=>{
 const [file]=await archive(t,[{Data:{DataResult:[{JobAdId:'1',Duty:body}]}}]);
 const original={job_id:'1',list_raw_file:file,description:body};
 const reviewed=reviewJobBody({...original,detail_error:'maintenance_detail_budget_exhausted'});
 assert.equal(reviewed.body_complete,true);assert.equal(reviewed.body_fetch.status,'available');
 for(const extra of [{body_is_summary:true},{detail_error:'ID mismatch'},{detail_error:'HTTP 500'}]){
  const result=reviewJobBody({...original,...extra});assert.equal(result.body_complete,false);
  assert.notEqual(result.body_fetch.status,'available');
 }
 assert.equal(reviewJobBody({...original,job_id:'2',detail_error:'maintenance_detail_budget_exhausted'}).body_complete,false);
});

test('contextual Chinese headings split requirements and retain optional bonuses',()=>{
 const description='校园大使职责：\n1、负责校内宣传。\n2、协助组织宣讲。\n校园大使要求：\n1、本科在读。\n2、具备活动组织能力。\n加分项：\n有学生会经历。';
 const reviewed=reviewJobBody({...job,description,requirements:''});
 assert.equal(reviewed.body_complete,true);
 assert.match(reviewed.requirements,/校园大使要求/);
 assert.match(reviewed.requirements,/学生会经历/);
 assert.deepEqual(reviewed.body_review.evidence.headings.map(x=>x.kind),['duties','requirements','bonus']);
});

test('common English qualification headings retain bonuses and stop before benefits',()=>{
 const description='Duties & Responsibilities/任务和职责:\nBuild reliable systems.\nWhat’s required:\nBachelor degree.\nStrong communication skills.\nWhat we offer:\nAnnual bonus.';
 const reviewed=reviewJobBody({...job,description,requirements:''});
 assert.equal(reviewed.body_complete,true);
 assert.match(reviewed.requirements,/Bachelor degree/);
 assert.doesNotMatch(reviewed.requirements,/Annual bonus/);
});

test('requirement verbs do not independently prove that responsibilities exist',()=>{
 const reviewed=reviewJobBody({...job,description:'公司介绍：欢迎加入。',requirements:'本科及以上学历。\n参与过大型项目。\n熟悉 Java。'});
 assert.equal(reviewed.body_complete,false);
 assert.equal(reviewed.body_review.sections.responsibilities,'not_identified');
 assert.equal(reviewed.body_review.sections.requirements,'identified');
});

test('strongly inverted description and requirements fields remain reviewable',()=>{
 const reviewed=reviewJobBody({...job,
  description:'1、本科及以上学历。\n2、熟悉 Java。\n3、具备沟通能力。',
  requirements:'1、负责服务端核心模块的设计、开发和交付。\n2、推动分布式系统性能优化方案落地。\n3、参与跨团队技术方案设计与评审。'});
 assert.equal(reviewed.body_complete,true);
 assert(reviewed.body_review.rules.includes('inverted_description_and_requirements_fields'));
 assert.equal(reviewed.body_review.sections.responsibilities,'identified');
 assert.equal(reviewed.body_review.sections.requirements,'identified');
});

test('headerless responsibility prose is not split at late requirement-like verbs',()=>{
 const description='职责描述：\n- 负责区域业务目标。\n- 了解竞争产品及竞争对手的活动，收集市场资讯并反馈。\n- 掌握并持续更新产品知识，确保推广信息准确。\n- 完成主管下达的临时任务。';
 const reviewed=reviewJobBody({...job,description,requirements:''});
 assert.equal(reviewed.body_complete,false);
 assert.equal(reviewed.requirements,'');
 assert.equal(reviewed.body_review.sections.responsibilities,'identified');
 assert.equal(reviewed.body_review.sections.requirements,'not_identified');
});

test('sentences ending in 要求 are not mistaken for requirement headings',()=>{
 const description='岗位职责：\n1、负责客户沟通并及时响应客户的要求。\n2、保证产品质量达到生产与交付要求。';
 const reviewed=reviewJobBody({...job,description,requirements:''});
 assert.equal(reviewed.requirements,'');
 assert.equal(reviewed.body_review.sections.requirements,'not_identified');
});

test('requirement extraction stops at common benefit and privacy boilerplate',()=>{
 const description='Responsibilities:\nBuild reliable systems.\nRequired Skills:\nBachelor degree.\nStrong communication skills.\nCompany Benefits\nAnnual bonus.\nPrivacy Notice - Active Candidates: example.com/privacy';
 const reviewed=reviewJobBody({...job,description,requirements:''});
 assert.equal(reviewed.body_complete,true);
 assert.match(reviewed.requirements,/Strong communication skills/);
 assert.doesNotMatch(reviewed.requirements,/Annual bonus|Privacy Notice/);
});

test('numbered task phrases in a dedicated description field count as responsibilities',()=>{
 const reviewed=reviewJobBody({...job,
  description:'1.方案与新品研发\n2.仿真、计算与技术论证\n3.样机试制与试验验证',
  requirements:'1.本科及以上学历。\n2.具备相关项目经验。'});
 assert.equal(reviewed.body_complete,true);
 assert(reviewed.body_review.rules.includes('structured_description_field'));
});

test('a requirement sentence mentioning 加分项 remains required evidence',()=>{
 const reviewed=reviewJobBody({...job,
  description:'岗位职责：\n负责内容运营。\n职位要求：\n英语能力或海外经历是加分项。\n善于沟通交流。',requirements:''});
 assert.equal(reviewed.body_complete,true);
 assert.match(reviewed.requirements,/英语能力/);
 assert.match(reviewed.requirements,/善于沟通/);
});

test('a bracketed bonus heading remains attached to the requirements field',()=>{
 const reviewed=reviewJobBody({...job,
  description:'岗位职责：\n负责内容运营。\n职位要求：\n本科及以上学历。\n【加分项】\n有海外经历。',requirements:''});
 assert.equal(reviewed.body_complete,true);
 assert.match(reviewed.requirements,/本科及以上/);
 assert.match(reviewed.requirements,/海外经历/);
 assert(reviewed.body_review.evidence.headings.some(x=>x.kind==='bonus'));
});

test('numbered role content before a requirement heading remains responsibility evidence',()=>{
 const description='加入我们，你将获得：\n1.参与数字化项目并完成需求分析。\n2.推动人工智能方案在业务中落地。\n我们期待这样的你：\n1.本科及以上学历。\n2.具备良好的英语能力。';
 const reviewed=reviewJobBody({...job,description,requirements:''});
 assert.equal(reviewed.body_complete,true);
 assert(reviewed.body_review.rules.includes('structured_description_field'));
});

test('labeled qualification lines are requirement evidence',()=>{
 const reviewed=reviewJobBody({...job,
  description:'1.负责产品设计和交付。\n2.推动跨团队项目落地。',
  requirements:'1.教育背景：本科及以上学历。\n2.语言能力：掌握英语。'});
 assert.equal(reviewed.body_complete,true);
 assert.equal(reviewed.body_review.sections.requirements,'identified');
});

test('a requirements field containing a full body can provide prefixed duties',()=>{
 const reviewed=reviewJobBody({...job,
  description:'我们希望你：\n1、本科及以上学历。\n2、具备沟通能力。',
  requirements:'方向一：产品营销\n1、参与产品营销项目。\n2、推动活动方案落地。\n任职要求：\n1、本科及以上学历。'});
 assert.equal(reviewed.body_complete,true);
 assert(reviewed.body_review.rules.includes('mixed_body_in_requirements_field'));
});

test('semantic clauses override a misleading description heading only with separate requirement evidence',()=>{
 const reviewed=reviewJobBody({...job,
  description:'实习要求\n1、协助完成招聘渠道维护。\n2、支持招聘流程改进项目。\n3、负责招聘数据统计。',
  requirements:'本科及以上学历。\n具备良好的沟通能力。'});
 assert.equal(reviewed.body_complete,true);
 assert(reviewed.body_review.rules.includes('semantic_description_clauses'));
});

test('numbered duties separated by whitespace are recognized',()=>{
 const reviewed=reviewJobBody({...job,
  description:'1 负责控制系统软件模块的设计。\n2 协助产品经理分析项目需求。',
  requirements:'1 本科及以上学历。\n2 熟悉 Java。'});
 assert.equal(reviewed.body_complete,true);
});

test('numbered qualification fallback retains a later bonus section',()=>{
 const reviewed=reviewJobBody({...job,
  description:'一、岗位职责：\n1.负责设备维护。\n2.处理产线故障。\n二、任职基本要求：\n1.本科及以上学历。\n2.三年相关经验。\n三、加分项：\n熟悉特定品牌设备优先。',
  requirements:'三、加分项：\n熟悉特定品牌设备优先。'});
 assert.equal(reviewed.body_complete,true);
 assert.match(reviewed.requirements,/本科及以上/);
 assert.match(reviewed.requirements,/加分项/);
 assert.match(reviewed.requirements,/特定品牌/);
});

test('numbered qualification fallback accepts an indented list restart before bonuses',()=>{
 const reviewed=reviewJobBody({...job,
  description:'1.负责知识资产梳理。\n2.推动知识共享机制。\n  1.本科及以上，三年知识管理经验。\n  2.具备跨部门沟通能力。\n  【加分项】\n  1.持有专业认证。',
  requirements:'【加分项】\n1.持有专业认证。'});
 assert.equal(reviewed.body_complete,true);
 assert.match(reviewed.requirements,/本科及以上/);
 assert.match(reviewed.requirements,/加分项/);
});

test('a requirements-only description does not become responsibility evidence from embedded verbs',()=>{
 const reviewed=reviewJobBody({...job,
  description:'任职资格：\n1、本科及以上学历。\n2、具有方案汇报能力，能与客户交流，参与市场拓展。',
  requirements:'任职资格：\n1、本科及以上学历。\n2、具有方案汇报能力，能与客户交流，参与市场拓展。'});
 assert.equal(reviewed.body_complete,false);
 assert.equal(reviewed.body_review.sections.responsibilities,'not_identified');
});

test('岗位说明 is an explicit responsibility heading inside otherwise mixed content',()=>{
 const reviewed=reviewJobBody({...job,
  description:'专业要求：\n微电子相关专业\n岗位说明：\n负责高速电路设计，支持模块开发。\n任职资格：\n熟悉混合信号设计。',
  requirements:'专业要求：\n微电子相关专业\n岗位说明：\n负责高速电路设计，支持模块开发。\n任职资格：\n熟悉混合信号设计。'});
 assert.equal(reviewed.body_complete,true);
 assert.equal(reviewed.body_review.sections.responsibilities,'identified');
 assert.equal(reviewed.body_review.sections.requirements,'identified');
});

test('capability sections do not become responsibilities from task-shaped examples',()=>{
 const reviewed=reviewJobBody({...job,
  description:'（一）通用能力\n1.沟通协调能力：能与多方沟通，推动工作落地。\n（二）专业能力\n1.组织执行能力：能够协助完成培训活动。',
  requirements:'本科及以上学历，沟通能力良好。'});
 assert.equal(reviewed.body_complete,false);
 assert.equal(reviewed.body_review.sections.responsibilities,'not_identified');
});

test('a talent program introduction does not substitute for actual responsibilities',()=>{
 const reviewed=reviewJobBody({...job,
  description:'“领航者”人才计划是公司级培养项目，通过跨部门实战培养，推动业务转型，培养解决方案专家。',
  requirements:'本科及以上学历，具备沟通能力。'});
 assert.equal(reviewed.body_complete,false);
 assert.equal(reviewed.body_review.sections.responsibilities,'not_identified');
});
