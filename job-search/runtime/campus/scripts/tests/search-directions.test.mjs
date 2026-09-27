import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewRecruitment} from '../lib/recruitment-policy.mjs';
import {routeKnownSource,sourceDirectionPlan,publicSiteConfig} from '../lib/source-directions.mjs';
import {eligibilityFields,modeEligibilityProblem,modeProfileProblem} from '../lib/search-mode.mjs';
import {sourceConfigFingerprint,mergeSourceResults} from '../lib/source-collector.mjs';
import {normalizeCustomJob} from '../lib/providers-custom.mjs';

const job=(title,e={},status='unknown')=>({title,formal_status:status,open_status:'open',recruitment_evidence:e,description:'岗位职责',requirements:'任职要求'});
test('明确实习身份可配合兼职时间；提前实习条件不改变校招身份',()=>{
 assert.equal(reviewRecruitment(job('数据分析实习生',{provider:'moka',commitment:'兼职',hireMode:2},'parttime'),'internship').formal_status,'internship');
 assert.equal(reviewRecruitment(job('校招数据分析（需提前实习）',{provider:'moka',commitment:'全职',hireMode:2},'formal'),'internship').formal_status,'formal');
 assert.equal(reviewRecruitment(job('金牌实习生夏令营',{provider:'51job_coapi',type:'实习'},'internship'),'internship').formal_status,'activity');
 assert.equal(reviewRecruitment(job('全职编辑',{provider:'beisen',Category:'实习生招聘',CategoryId:3,Kind:'全职'}),'internship').formal_status,'internship');
});
test('社招分类依赖返回身份；未知全职保留未知，校园/实习不改为社招',()=>{
 const result=reviewRecruitment(job('开发工程师',{provider:'feishu',recruit_type:{id:'101',name:'正式',parent:{id:'1',name:'社招'}}}),'social');
 assert.equal(result.formal_status,'social');
 assert.equal(reviewRecruitment(job('开发工程师',{commitment:'全职'}),'social').formal_status,'unknown');
 assert.equal(reviewRecruitment(job('研发',{provider:'moka',hireMode:2,commitment:'全职'}),'social').formal_status,'formal');
 assert.equal(reviewRecruitment(job('研发',{provider:'moka',hireMode:1,showIsCampus:true,commitment:'全职'}),'social').formal_status,'social');
 assert.equal(reviewRecruitment(job('产品实习生',{commitment:'全职'}),'social').formal_status,'internship');
 assert.equal(reviewRecruitment(job('工程师',{provider:'zhaopin_grace',type_conflict:{types:['social','formal']}},'social'),'social').formal_status,'unknown');
});
test('北森/红海路由保留租户且不修改原配置，不使用未经验证的实习枚举',()=>{
 const source={provider:'beisen',api_config:{tenant:'same'},validated_api_request_examples:[{url:'https://example.com/GetJobAdPageList',body:{Category:['2'],PortalId:'P1',OrgId:'O1',Kind:['2']}}]};
 const clone=structuredClone(source),social=routeKnownSource(source,'social'),intern=routeKnownSource(source,'internship');
 assert.deepEqual(social.validated_api_request_examples[0].body,{Category:['1'],PortalId:'P1',OrgId:'O1'});
 assert.deepEqual(intern.validated_api_request_examples[0].body.Category,['1','2','3']);assert.deepEqual(source,clone);
 const hot=routeKnownSource({provider:'hotjob',validated_api_request_examples:[{url:'https://example.com/listPosition/SU123',body:'orgId=keep&recruitType=1'}]},'social');
 assert.equal(new URLSearchParams(hot.validated_api_request_examples[0].body).get('recruitType'),'2');
 assert.equal(new URLSearchParams(hot.validated_api_request_examples[0].body).get('orgId'),'keep');
});
test('公开配置使用真实站点ID与website-path，JSON解析不执行页面脚本',()=>{
 const moka=publicSiteConfig('<input id="init-data" value="{&quot;siteId&quot;:&quot;43535&quot;,&quot;mode&quot;:&quot;social&quot;}">','moka');assert.equal(moka.siteId,'43535');
 const feishu=publicSiteConfig('<script id="js-websiteInfo" type="application/json">{"website_info":{"path":"society"}}</script>','feishu');assert.equal(feishu.website_info.path,'society');
 assert.equal(publicSiteConfig('<script>throw Error("not executed")</script>','feishu'),null);
});
test('各招聘方向指纹隔离，纯校招接口继承但不声称社招已验证',()=>{
 const source={provider:'campus_only_fixture',primary_entry_url:'https://example.com'};
 assert.notEqual(sourceConfigFingerprint(source,'campus'),sourceConfigFingerprint(source,'social'));
 assert.notEqual(sourceConfigFingerprint(source,'internship'),sourceConfigFingerprint(source,'social'));
 assert.equal(sourceDirectionPlan(source,'social').scope,'target_channel_not_verified');
});
test('实习/社招合并不把目标方向缺正文当完整覆盖',()=>{
 for(const mode of ['internship','social']) {
  const source={company_id:'C',provider:'feishu',primary_entry_url:'https://example.com',source_id:'s'};
  const merged=mergeSourceResults(source,[{source,result:{jobs:[{job_id:'1',formal_status:mode,open_status:'open',body_complete:false}],coverage:{status:'complete',pages:1},requests:[]}}],{mode:'full',targetMode:mode});
  assert.equal(merged.coverage.status,'partial');
 }
});
test('社招无需毕业时间，但必须有学历与真实正式工作年限，包括0年',()=>{
 const profile={degree:'本科',employment_years:0};assert.equal(modeProfileProblem(profile,'social'),null);
 assert.match(modeProfileProblem({degree:'本科'},'social'),/正式工作年限/);
 const checks=eligibilityFields('social').map(field=>({field,status:'not_stated',jd_requirement:'JD未写限制',candidate_fact:'按个人材料记录'}));
 const review={eligibility:'eligible',eligibility_checks:checks,next_action:'prepare'};assert.equal(modeEligibilityProblem(review,profile,'social'),null);
 review.eligibility_checks[1]={field:'employment_years',status:'conflict',jd_requirement:'需3年以上工作经验',candidate_fact:'用户0年正式工作'};
 assert.match(modeEligibilityProblem(review,profile,'social'),/矛盾/);review.eligibility='ineligible';assert.equal(modeEligibilityProblem(review,profile,'social'),null);
});
test('实习周天数与时长硬限制未知不能被输出为可直接投递',()=>{
 const profile={degree:'本科',graduation:'2027-06',student_status:'enrolled',internship_availability:{start_date:null,days_per_week:null,duration_months:null}};
 const checks=eligibilityFields('internship').map(field=>({field,status:field==='days_per_week'?'unknown':'not_stated',jd_requirement:field==='days_per_week'?'每周4天':'未要求',candidate_fact:'未提供'}));
 const review={eligibility:'unknown',eligibility_checks:checks,next_action:'apply'};
 assert.match(modeEligibilityProblem(review,profile,'internship'),/不能建议直接投递/);review.next_action='prepare';assert.equal(modeEligibilityProblem(review,profile,'internship'),null);
 checks.pop();assert.match(modeEligibilityProblem(review,profile,'internship'),/全部必需/);
});
test('实测自建类型：SHEIN PRACTICE、携程社招渠道实习、米哈游社会招聘',()=>{
 const source={display_name:'fixture',company_id:'fixture',primary_entry_url:'https://example.com'};
 assert.equal(normalizeCustomJob('shein',{jobId:'1',jobTitle:'运营实习',jobTypeId:'PRACTICE'},source).formal_status,'internship');
 assert.equal(normalizeCustomJob('ctrip',{id:'2',jobTitle:'人力实习生',category:'1',kind:'3'},source).formal_status,'internship');
 assert.equal(normalizeCustomJob('mihoyo',{id:'3',title:'资深开发',jobNature:'全职',hireType:0,hireTypeName:'社会招聘'},source).formal_status,'social');
 assert.equal(normalizeCustomJob('mihoyo',{id:'4',title:'资深开发',jobNature:'全职',projectName:'社会招聘'},source).formal_status,'social');
 assert.equal(normalizeCustomJob('meituan',{jobUnionId:'5',name:'未知类型职位',jobType:99},source).formal_status,'unknown');
 assert.equal(normalizeCustomJob('mihoyo',{id:'4',title:'资深开发',jobNature:'全职',projectName:'社会招聘'},source).official_url,'https://jobs.mihoyo.com/#/position/4');
 assert.match(normalizeCustomJob('meituan',{jobUnionId:'5',name:'社招运营',jobType:3},source).official_url,/highlightType=social$/);
});
test('目标城市之外省略详情不造成虚假的不完整；未知城市仍要求正文',()=>{
 const source={company_id:'C',provider:'openout',primary_entry_url:'https://example.com',source_id:'s'};
 const row={job_id:'1',formal_status:'internship',open_status:'open',body_complete:false,locations_raw:['北京']};
 const combine=jobs=>mergeSourceResults(source,[{source,result:{jobs,coverage:{status:'complete',pages:1},requests:[]}}],{mode:'full',targetMode:'internship',cities:['上海']});
 assert.equal(combine([row]).coverage.status,'complete');
 assert.equal(combine([{...row,locations_raw:['上海']}]).coverage.status,'partial');
 assert.equal(combine([{...row,locations_raw:[]}]).coverage.status,'partial');
});
test('方向有限但采集已结束可以缓存；实际分页失败不能被缓存完整标记掩盖',()=>{
 const source={company_id:'C',provider:'fixture',primary_entry_url:'https://example.com',source_id:'s'};
 const merge=coverage=>mergeSourceResults(source,[{source,result:{jobs:[],coverage,requests:[]}}],{mode:'full',targetMode:'social'}).coverage;
 const limited=merge({status:'partial',collection_complete:true,reason:'target channel unknown'});
 assert.equal(limited.status,'partial');assert.equal(limited.collection_complete,true);
 assert.equal(merge({status:'partial',reason:'page failed'}).collection_complete,false);
});
