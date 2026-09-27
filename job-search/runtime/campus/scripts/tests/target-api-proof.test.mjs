import './context.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {targetApiProof,reconcileTargetJob} from '../lib/target-api-proof.mjs';
// All fixtures below are OFFLINE SYNTHETIC; they are never live source evidence.
const source={company_id:'synthetic',source_id:'offline-synthetic',provider:'moka'};
const base={company_id:'synthetic',job_id:'synthetic-job',title:'软件工程师',description:'负责软件功能设计开发、项目落地和质量维护。',requirements:'计算机相关专业，熟悉软件开发、工程实践与团队协作。',body_complete:true,open_status:'open',official_url:'https://offline-fixture.invalid/job/1',job_url_kind:'official_detail'};
const proof=(e={},mode='social',job={},s=source)=>targetApiProof({...base,...job,recruitment_evidence:e},s,mode);

test('recovered employer enums and bound public plans prove actual directions',()=>{
 for(const e of [{provider:'xiaohongshu',recruitType:'club_recruit'},{provider:'kuaishou',positionNatureCode:'C001',recruitProjectCode:'socialr'},{provider:'bilibili',positionTypeName:'全职',recruitType:0,api_endpoint:'https://jobs.bilibili.com/api/srs/position/positionList'}])assert.equal(proof(e).accepted,true);
 for(const e of [{provider:'tencent',projectName:'应届实习'},{provider:'jd',planId:51,public_project:{id:51,planName:'新锐之星实习生'}},{provider:'kuaishou',positionNatureCode:'C002'}])assert.equal(proof(e,'internship').accepted,true);
 assert.equal(proof({provider:'jd',planId:52,public_project:{id:51,planName:'实习生'}},'internship').accepted,false);
 assert.equal(proof({provider:'bilibili',positionTypeName:'全职',recruitType:0,api_endpoint:'https://jobs.bilibili.com/api/campus/position/positionList'}).accepted,false);
 assert.equal(proof({provider:'tencent',RequireWorkYearsName:'五年以上工作经验',api_endpoint:'https://careers.tencent.com/tencentcareer/api/post/Query?attrId=1'}).accepted,true);
 assert.equal(proof({provider:'tencent',RequireWorkYearsName:'经验不限',api_endpoint:'https://careers.tencent.com/tencentcareer/api/post/Query?attrId=1'}).accepted,false);
});
test('known social endpoint still requires independent mandatory professional requirements',()=>{
 const e={provider:'baidu',api_endpoint:'https://talent.baidu.com/httservice/getPostListNew',query_recruit_type:'SOCIAL'};
 assert.equal(proof(e).accepted,false);
 assert.equal(proof(e,'social',{requirements:'本科以上学历，需3年以上Java开发经验，熟悉服务端技术与数据库。'}).accepted,true);
 assert.equal(proof(e,'social',{requirements:'本科以上学历，有3年以上Java开发经验优先。'}).accepted,false);
 assert.equal(proof({...e,query_recruit_type:'INTERN'},'social',{requirements:'本科以上学历，需3年以上Java开发经验，熟悉服务端技术与数据库。'}).accepted,false);
});
test('runtime full-JD reconciliation rejects inherited false positives and restores genuine targets',()=>{
 assert.equal(reconcileTargetJob({...base,formal_status:'social',recruitment_evidence:{provider:'moka',commitment:'全职'}},source,'social').formal_status,'unknown');
 assert.equal(reconcileTargetJob({...base,formal_status:'formal',recruitment_evidence:{provider:'moka',hireMode:1,showIsCampus:true,commitment:'全职'}},source,'social').formal_status,'social');
 const campus={...base,formal_status:'formal'};assert.equal(reconcileTargetJob(campus,source,'campus'),campus);
});
test('audit proof rejects inferred social status and unlabeled full-time',()=>assert.equal(proof({provider:'moka',commitment:'全职',campus_context:false},'social',{formal_status:'social'}).accepted,false));
test('audit proof rejects management trainee as generic social evidence',()=>assert.equal(proof({provider:'moka',commitment:'全职',projectName:'Global Management Trainee'}).accepted,false));
test('early internship and internship-experience eligibility do not prove internships',()=>{
 for(const e of [{provider:'moka',hireMode:2,commitment:'全职',projectName:'2027届校招（可提前实习）'},{provider:'moka',hireMode:2,commitment:'全职',objectName:'2027届毕业生，实习经历优先'}])assert.equal(proof(e,'internship').accepted,false);
});
test('actual internship titles can coexist with campus channel and part-time schedule',()=>assert.equal(proof({provider:'moka',hireMode:2,commitment:'兼职'},'internship',{title:'日常实习生-后端开发'}).accepted,true));
test('Moka returned hireMode1 proves social despite unreliable showIsCampus flag',()=>assert.equal(proof({provider:'moka',hireMode:1,showIsCampus:true,commitment:'全职'}).accepted,true));
test('unknown LightBolt Kind2 is not internship identity',()=>assert.equal(proof({provider:'beisen_lightbolt',CategoryId:9,Kind:2,KindLabel:'全职'},'internship').accepted,false));
test('Hotjob observed frontend enum12 is internship only when actually returned',()=>{
 assert.equal(proof({provider:'hotjob',recruitType:12},'internship').accepted,true);
 assert.equal(proof({provider:'hotjob',recruitType:3},'internship').accepted,false);
 assert.equal(proof({provider:'hotjob'},'internship',{}, {...source,provider:'hotjob',requested_recruitType:12}).accepted,false);
});
test('CEC workNature internship takes priority over social channel',()=>{
 const j={raw_metadata:{work_nature:'实习'}};assert.equal(proof({provider:'cec_campus',position_type:1},'social',j).accepted,false);assert.equal(proof({provider:'cec_campus',position_type:1},'internship',j).accepted,true);
});
test('known provider enums support both directions and are scoped by provider',()=>{
 for(const e of [{provider:'beisen',CategoryId:3},{provider:'beisen_lightbolt',CategoryId:3},{provider:'feishu',recruit_type:{id:'202',name:'实习',parent:{id:'2',name:'校招'}}},{provider:'shein',jobTypeId:'PRACTICE'},{provider:'meituan',jobType:'2'},{provider:'ccb_public',plan_type:'SX'}])assert.equal(proof(e,'internship').accepted,true,JSON.stringify(e));
 for(const e of [{provider:'beisen',CategoryId:1},{provider:'feishu',recruit_type:{id:'101',name:'正式',parent:{id:'1',name:'社招'}}},{provider:'hotjob',recruitType:2},{provider:'mihoyo',hireType:0,jobNature:'全职'},{provider:'meituan',jobType:'3'},{provider:'shein',jobTypeId:'SOCIAL'},{provider:'cec_campus',position_type:1},{provider:'hcmcloud_public',job_class:'社会招聘'}])assert.equal(proof(e).accepted,true,JSON.stringify(e));
 assert.equal(proof({provider:'unknown',jobType:'3'}).accepted,false);
});
test('explicit formal-campus child type conflicts with internship title',()=>assert.equal(proof({provider:'feishu',recruit_type:{id:'201',name:'正式',parent:{id:'2',name:'校招'}}},'internship',{title:'研发实习生'}).accepted,false));
test('social evidence conflicting with explicit campus project cannot pass',()=>assert.equal(proof({provider:'moka',hireMode:1,projectName:'2027届校园招聘'}).accepted,false));
test('structured years require mandatory JD corroboration, not a preferred condition',()=>{
 const e={provider:'zhaopin_grace'};assert.equal(proof(e,'social',{raw_metadata:{workingExpName:'1-3年'},requirements:'本科及以上学历，至少1年相关开发经验，熟悉软件开发与团队协作。'}).accepted,true);
 assert.equal(proof(e,'social',{raw_metadata:{workingExpName:'1-3年'},requirements:'本科及以上学历，有1年相关开发经验优先。'}).accepted,false);
 assert.equal(proof(e,'social',{raw_metadata:{workingExpName:'1-3年'}}).accepted,false);
});
test('full-time plus mandatory non-intern work experience proves social without structured years',()=>{
 for(const requirements of ['Required Qualifications\nAt least 5 years of relevant professional experience.','Minimum Qualifications\n3+ years\u2019 experience in software development.','任职要求\n本科及以上学历，至少3年相关开发经验，熟悉工程实践。'])assert.equal(proof({provider:'workday',timeType:'Full time'},'social',{requirements}).accepted,true,requirements);
 assert.equal(proof({provider:'microsoft_eightfold',employment_type:['Full-time']},'social',{requirements:'Required Qualifications\nMinimum 5 years of related experience.'}).accepted,true);
});
test('full-time experience path rejects preferences, zero, internship experience and graduate identity',()=>{
 for(const requirements of ['5 years of experience preferred.','Preferred Qualifications\n5 years of work experience.','0-3 years of experience.','0 to 3 years of experience.','No experience is required; 5 years of work experience preferred.','3 years of internship experience.','1年实习经验。','有3年经验优先。'])assert.equal(proof({provider:'workday',timeType:'Full time'},'social',{requirements}).accepted,false,requirements);
 assert.equal(proof({provider:'workday',timeType:'Full time'},'social',{title:'Graduate Programme Engineer',requirements:'5 years of work experience required.'}).accepted,false);
 assert.equal(proof({provider:'workday',timeType:'Full time',workerType:'Intern'},'social',{requirements:'5 years of work experience required.'}).accepted,false);
 assert.equal(proof({provider:'microsoft_eightfold',employment_type:['Intern','Full-time']},'social',{requirements:'5 years of work experience required.'}).accepted,false);
});
test('listing URL with stable ID is honestly accepted as listing_with_id',()=>{
 const r=proof({provider:'hotjob',recruitType:2},'social',{official_url:'https://offline-fixture.invalid/jobs',job_url_kind:'official_listing'});assert.equal(r.accepted,true);assert.equal(r.evidence.find(x=>x.field==='jd_link').value.link_kind,'listing_with_id');
 assert.equal(proof({provider:'hotjob',recruitType:2},'social',{job_id:'',job_url_kind:'official_listing'}).accepted,false);
});
test('closed, incomplete, activity, missing-link and tenant-conflict rows never pass',()=>{
 const e={provider:'hotjob',recruitType:2};for(const j of [{open_status:'closed'},{body_complete:false},{official_url:''},{title:'2027夏令营'},{company_id:'other'}])assert.equal(proof(e,'social',j).accepted,false);
 assert.equal(proof({...e,tenant_mismatch:true}).accepted,false);
});
