import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {collectRecoveredDirection,normalizeDirectionRecovered,kuaishouPublicSignature} from '../lib/providers-direction-recovered.mjs';
const source=key=>({company_id:'fixture-'+key,display_name:key,provider:key});
const ctx=(endpoint,targetMode='social')=>({endpoint,targetMode,listFile:'fixture-list.json'});
const normal=(key,row,context)=>normalizeDirectionRecovered(key,row,source(key),context);
const desc='负责日常产品研发、需求沟通与质量改进，参与跨部门协作。';
const req='本科及以上学历，3年以上Java开发经验，熟练使用SQL，具备沟通能力。';
function mockClient(fn){const records=[];return {records,cookieValue:()=>null,setCookie(){},async request(q,{purpose}){const data=await fn(q,purpose),record={http_status:200,url:q.url,body:q.body,response_file:`fixture-${records.length}.json`,purpose};records.push(record);return {data,record};}};}

test('unsupported directions return null without HTTP',async()=>{
 const client=mockClient(()=>{throw Error('must not request');});
 for(const [key,targetMode]of [['baidu','campus'],['pdd','social'],['unrelated','social']])assert.equal(await collectRecoveredDirection(source(key),{targetMode,client}),null);
 assert.equal(await collectRecoveredDirection({company_id:'wrong',display_name:'百度',provider:'unrelated'},{targetMode:'social',client}),null);
 assert.equal(client.records.length,0);
});
test('public signature sorts values, omits empty values and preserves exact timestamp',()=>{
 const query={z:['b','a'],a:'a b',empty:'',nothing:null},t=1234,key='652f962a-0575-4575-98d2-f04e2291bee2';
 assert.equal(kuaishouPublicSignature(query,t),createHmac('sha256',key).update('1234a=a+b&z=a,b'+key).digest('hex'));
});
test('request direction alone cannot make an unlabeled JD social',()=>{
 const j=normal('baidu',{postId:'1',name:'数据分析师',workContent:desc,serviceCondition:'本科及以上学历，了解SQL，沟通积极。'},ctx('https://talent.baidu.com/httservice/getPostListNew'));
 assert.equal(j.formal_status,'unknown');
 const explicit=normal('baidu',{postId:'1',name:'开发工程师',workContent:desc,serviceCondition:req},ctx('https://talent.baidu.com/httservice/getPostListNew'));
 assert.equal(explicit.formal_status,'social');assert.ok(explicit.recruitment_evidence.professional_experience_basis);
});
test('Bilibili shared recruitType zero is disambiguated by returned employment and endpoint',()=>{
 const row={id:1,positionName:'广告策划',positionDescription:`工作职责:\n${desc}\n工作要求:\n${req}`,recruitType:0,positionTypeName:'全职'};
 const social=normal('bilibili',row,ctx('https://jobs.bilibili.com/api/srs/position/positionList'));
 assert.equal(social.formal_status,'social');assert.equal(social.body_complete,true);assert.match(social.official_url,/\/social\/positions\/1$/);
 assert.equal(normal('bilibili',row,ctx('https://jobs.bilibili.com/api/campus/position/positionList')).formal_status,'unknown');
 assert.equal(normal('bilibili',{...row,positionTypeName:'实习'},ctx('https://jobs.bilibili.com/api/campus/position/positionList','internship')).formal_status,'internship');
});
test('returned XHS and Kuaishou direction enums take precedence over query context',()=>{
 assert.equal(normal('xiaohongshu',{positionId:1,positionName:'产品',recruitType:'club_recruit',recruitStatus:'in_recruitment',duty:desc,qualification:req},ctx('https://job.xiaohongshu.com/','internship')).formal_status,'social');
 for(const [nature,status]of [['C001','social'],['C002','internship']])assert.equal(normal('kuaishou',{id:1,name:'产品',positionNatureCode:nature,recruitProjectCode:'socialr',description:desc,positionDemand:req},ctx('https://zhaopin.kuaishou.cn/')).formal_status,status);
});
test('PDD internship is not converted to campus by XZ metadata; ambassador excluded',()=>{
 const row={id:1,name:'HR实习生',code:'XZ0000030',graduationYear:'2027',recruitTypeName:'管培生',jobDuty:desc,serveRequirement:'本科在校生，可连续实习3个月以上，每周4天。'};
 assert.equal(normal('pdd',row,ctx('https://careers.pinduoduo.com/','internship')).formal_status,'internship');
 assert.equal(normal('pdd',{...row,name:'校园大使（2027届校招）'},ctx('https://careers.pinduoduo.com/','internship')).formal_status,'activity');
});
test('Tencent fresh project mapping handles comma-separated project IDs and preserves bonuses',()=>{
 const j=normal('tencent',{postId:'1',title:'后台开发',projectId:12,desc,request:req,graduateBonus:'补充提交要求：请附作品链接。',internBonus:'每周至少实习四天。'},{...ctx('https://join.qq.com/','internship'),projectMappings:[{projectId:'4,12',projectName:'日常实习'}]});
 assert.equal(j.formal_status,'internship');assert.match(j.requirements,/作品链接/);assert.match(j.requirements,/每周/);assert.equal(j.body_complete,true);
 assert.equal(normal('tencent',{postId:'2',title:'实习生',graduateBonus:req},ctx('https://join.qq.com/','internship')).body_complete,false);
});
test('Tencent careers social stream uses returned work years and full detail without touching join.qq',async()=>{
 const client=mockClient((q,purpose)=>{
  assert.match(q.url,/^https:\/\/careers\.tencent\.com\/tencentcareer\/api\/post\//);const u=new URL(q.url);assert.ok(u.searchParams.get('timestamp'));
  if(purpose==='job_list'){assert.equal(u.searchParams.get('pageSize'),'10');assert.equal(u.searchParams.get('attrId'),'1');return {Code:200,Data:{Count:1,Posts:[{PostId:'123',RecruitPostName:'多媒体标准专家',Responsibility:desc,LocationName:'北京',IsValid:true,RequireWorkYearsName:'五年以上工作经验',PostURL:'http://careers.tencent.com/jobdesc.html?postId=123'}]}};}
  assert.match(q.url,/\/ByPostId\?/);assert.equal(u.searchParams.get('postId'),'123');return {Code:200,Data:{PostId:'123',RecruitPostName:'多媒体标准专家',Responsibility:desc,Requirement:req,RequireWorkYearsName:'五年以上工作经验'}};
 });
 const out=await collectRecoveredDirection(source('tencent'),{targetMode:'social',client,pageSize:30,maxPages:1});
 assert.equal(out.coverage.status,'complete');assert.equal(out.jobs[0].job_id,'social:123');assert.equal(out.jobs[0].body_complete,true);assert.equal(out.jobs[0].formal_status,'social');assert.equal(out.jobs[0].recruitment_evidence.RequireWorkYearsName,'五年以上工作经验');assert.equal(out.jobs[0].raw_metadata.experience,'五年以上工作经验');assert.equal(out.requests.length,2);
 const uncertain=normal('tencent',{PostId:'456',RecruitPostName:'开发',Responsibility:desc,Requirement:'掌握基本算法知识，具备沟通能力和自驱力。',RequireWorkYearsName:'工作经验不限'},ctx('https://careers.tencent.com/tencentcareer/api/post/Query'));assert.equal(uncertain.formal_status,'unknown');
 const conflicting=normal('tencent',{PostId:'789',RecruitPostName:'校招开发',Responsibility:desc,Requirement:req,RequireWorkYearsName:'两年以上工作经验'},ctx('https://careers.tencent.com/tencentcareer/api/post/Query'));assert.equal(conflicting.formal_status,'unknown');assert.ok(conflicting.recruitment_evidence.type_conflict);
});
test('Alibaba social requires actual experience; null status is not treated as closed',()=>{
 const j=normal('alibaba',{id:1,name:'产品专家',status:null,experience:{from:8},description:desc,requirement:req,positionUrl:'/off-campus/position-detail?positionId=1'},ctx('https://talent.alibaba.com/position/search'));
 assert.equal(j.formal_status,'social');assert.equal(j.open_status,'open');assert.equal(j.official_url,'https://talent.alibaba.com/off-campus/position-detail?positionId=1');
});
test('JD social IDs cannot collide with campus IDs; no invented detail webpage',()=>{
 const j=normal('jd',{id:1,positionName:'研发工程师',workContent:desc,qualification:req},ctx('https://zhaopin.jd.com/web/job/job_list'));
 assert.equal(j.job_id,'social:1');assert.equal(j.formal_status,'social');assert.equal(j.job_url_kind,'official_listing');
 const intern=normal('jd',{publishId:1,planId:51,positionName:'研发',workContent:desc,qualification:'本科在校生。',workWeeklyDays:4,internshipDays:90},{...ctx('https://campus.jd.com/','internship'),jdPlans:{51:{project_type:'实习生',planName:'新锐之星实习生'}}});assert.equal(intern.formal_status,'internship');assert.equal(intern.raw_metadata.structured_conditions.workWeeklyDays,4);assert.equal(intern.raw_metadata.structured_conditions.internshipDays,90);
 const experienced=normal('jd',{id:2,positionName:'业务拓展岗',workContent:desc,qualification:'具备多元化场景业务拓展的全局操盘经验，熟悉CBD场景。'},ctx('https://zhaopin.jd.com/web/job/job_list'));assert.equal(experienced.formal_status,'social');
 const course=normal('jd',{id:3,positionName:'业务拓展岗',workContent:desc,qualification:'具备课程项目经验，熟悉基础SQL。'},ctx('https://zhaopin.jd.com/web/job/job_list'));assert.equal(course.formal_status,'unknown');
});
test('pagination only reaches complete after unique count reconciles and preserves request evidence',async()=>{
 const client=mockClient(q=>{const p=Number(new URLSearchParams(q.body).get('curPage'));return {data:{total:2,list:[{postId:String(p),name:'开发'+p,workContent:desc,serviceCondition:req}]}};});
 const out=await collectRecoveredDirection(source('baidu'),{targetMode:'social',client,pageSize:1,maxPages:2});
 assert.equal(out.jobs.length,2);assert.equal(out.coverage.status,'complete');assert.equal(out.coverage.pages.length,2);assert.equal(out.requests.length,2);
 assert.equal(out.jobs[0].recruitment_evidence.query_recruit_type,'SOCIAL');
});
test('Baidu caps oversized pageSize at verified 20 throughout pagination in both directions',async()=>{
 for(const targetMode of ['social','internship']){
  const client=mockClient(q=>{const params=new URLSearchParams(q.body);assert.equal(params.get('pageSize'),'20');const page=Number(params.get('curPage'));return {data:{total:40,list:Array.from({length:20},(_,i)=>({postId:String((page-1)*20+i+1),name:'研发工程师',projectType:targetMode==='internship'?'日常实习项目':'',workContent:desc,serviceCondition:req}))}};});
  const out=await collectRecoveredDirection(source('baidu'),{targetMode,client,pageSize:30,maxPages:2});
  assert.equal(out.coverage.status,'complete');assert.equal(out.jobs.length,40);assert.equal(out.requests.length,2);assert.deepEqual(out.requests.map(r=>new URLSearchParams(r.body).get('curPage')),['1','2']);
 }
});
test('repeated page and max-page limit remain partial instead of pretending complete',async()=>{
 const client=mockClient(()=>({data:{total:5,list:[{postId:'1',name:'开发',workContent:desc,serviceCondition:req}]}}));
 const out=await collectRecoveredDirection(source('baidu'),{targetMode:'social',client,pageSize:1,maxPages:3});
 assert.equal(out.coverage.status,'partial');assert.match(out.coverage.reason,/duplicate|repeated/);assert.equal(out.jobs.length,1);
});
test('XHS detail limit preserves unevaluated rows and returned type from actual detail',async()=>{
 const rows=[1,2].map(id=>({positionId:id,positionName:'产品'+id,duty:desc,qualification:req,recruitStatus:'in_recruitment'}));
 const client=mockClient((q,purpose)=>purpose==='job_list'?{data:{total:2,list:rows}}:{data:{...rows[0],recruitType:'club_recruit'}});
 const out=await collectRecoveredDirection(source('xiaohongshu'),{targetMode:'social',client,pageSize:1,maxPages:1,validationMaxDetails:1});
 assert.equal(out.jobs.length,2);assert.equal(out.jobs[0].formal_status,'social');assert.equal(out.jobs[1].formal_status,'unknown');assert.equal(out.coverage.status,'partial');assert.equal(out.coverage.details_skipped_limit,1);
 const list=out.requests.find(r=>r.purpose==='job_list');assert.equal(list.body.pageSize,10);
});
test('wrong detail identity cannot overwrite the valid list row',async()=>{
 const client=mockClient((q,purpose)=>purpose==='job_list'?{data:{total:1,list:[{positionId:1,positionName:'产品',duty:desc,qualification:req}]}}:{data:{positionId:999,positionName:'其他公司职位',recruitType:'club_recruit',duty:desc,qualification:req}});
 const out=await collectRecoveredDirection(source('xiaohongshu'),{targetMode:'social',client,maxPages:1});
 assert.equal(out.jobs[0].job_id,'1');assert.equal(out.jobs[0].formal_status,'unknown');assert.equal(out.coverage.detail_failures,1);assert.match(out.coverage.reason,/different ID/);
});
