import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectInternational,assertWorkdayDetailIdentity,normalizeWorkday} from '../lib/providers-international.mjs';
import {collectWorkdayLocationFallback} from '../lib/workday-location-fallback.mjs';
import {collectOracleNowcoder} from '../lib/providers-oracle-nowcoder.mjs';
import {reviewRecruitment} from '../lib/recruitment-policy.mjs';
import {reviewJobBody} from '../lib/body-review.mjs';
const source={company_id:'fixture',display_name:'Fixture',provider:'workday',api_config:{origin:'https://fixture.example',tenant:'fixture',site:'careers'}};
const description='Responsibilities\nDevelop software services and maintain production systems with engineering teams.\nQualifications\nBachelor degree in computer science; experience with software development and good communication skills.';
const row=id=>({externalPath:'/job/Shanghai/Engineer_'+id,bulletFields:[id],title:'Graduate Engineer',locationsText:'Shanghai'});
const detail=id=>({jobPostingInfo:{jobReqId:id,title:'Graduate Engineer',jobDescription:description,country:{descriptor:'China'},location:'Shanghai',canApply:true,timeType:'Full time',externalUrl:'https://fixture.example/job/'+id}});
const mock=fn=>({records:[],async request(q,m){const data=await fn(q,m),record={http_status:200,response_file:null};this.records.push({...record,url:q.url,purpose:m.purpose});return {data,text:JSON.stringify(data),record};}});
const facets=[{facetParameter:'country',values:[{descriptor:'China',id:'CN'}]}],locations=[{facetParameter:'locations',values:[{descriptor:'Shanghai',id:'SH'}]}];
const bootstrap={facets,jobPostings:[],total:0};

test('Workday recognizes Who you are as the requirements section',()=>{
 const raw={jobPostingInfo:{jobReqId:'UPM1',title:'Quality Engineer',jobDescription:'What you will do\nImprove product quality and work with production teams across the site.\n\nWho you are\nYou have a bachelor degree and relevant quality experience.',country:{descriptor:'China'},location:'Changshu',canApply:true,timeType:'Full time',externalUrl:'https://fixture.example/job/UPM1'}};
 const job=normalizeWorkday(raw,source,{response_file:'fixture.json'});
 assert.equal(job.body_complete,true);
 assert.match(job.requirements,/Who you are/);
 assert.match(job.requirements,/bachelor degree/);
});
test('Workday recognizes What You Bring as the requirements section',()=>{
 const raw={hiringOrganization:{name:'Rhenus Logistics China Ltd.'},jobPostingInfo:{jobReqId:'JR1',title:'Business Development Manager',jobDescription:'What You Can Expect:\nDevelop customer solutions and manage opportunity pipelines with the regional delivery team.\nWhat You Bring:\nBachelor degree and more than three years of logistics experience.',location:'Guangzhou, China',country:{descriptor:'China'},externalUrl:'https://fixture.invalid/job/JR1',canApply:true,timeType:'Full time'}};
 const job=normalizeWorkday(raw,{company_id:'rhenus',display_name:'Rhenus'}, {response_file:'raw.json'});
 assert.equal(job.body_complete,true);
 assert.match(job.requirements,/What You Bring/);
});

test('Workday identity accepts observed numeric, underscore/hyphen requisitions and posting versions',()=>{
 for(const id of ['2604216','R_363782','249346W','R-102607','JR-70222'])for(const suffix of ['', '-1','-5']) {
   const observed={externalPath:'/job/Shanghai/Engineer_'+id+suffix};
   assert.doesNotThrow(()=>assertWorkdayDetailIdentity(observed,detail(id)));
 }
 assert.doesNotThrow(()=>assertWorkdayDetailIdentity({externalPath:'/job/Shanghai/opaque',bulletFields:['R_363782']},detail('R_363782')));
 assert.throws(()=>assertWorkdayDetailIdentity(row('R1'),detail('R999')),/ID mismatch/);
 assert.throws(()=>assertWorkdayDetailIdentity({externalPath:'/job/Shanghai/Engineer_R1-1'},detail('1')),/ID mismatch/);
});
for(const route of ['country','locations'])test('Workday '+route+' route quarantines mismatched detail, retaining list evidence',async()=>{
 const client=mock((q,m)=>m.purpose==='public_country_facet_discovery'?bootstrap:/job_list/.test(m.purpose)?{total:2,jobPostings:[row('R1'),row('R2')]}:detail('R999'));
 const options={client,mode:'full',bootstrap:{data:{facets:locations}}};
 const r=route==='country'?await collectInternational(source,options):await collectWorkdayLocationFallback(source,options);
 assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.details_failed,2);assert.equal(r.jobs.length,2);
 assert.ok(r.jobs.every(j=>j.job_id!=='R999'&&!j.body_complete&&j.formal_status==='unknown'&&j.open_status==='unknown'));
 assert.ok(r.jobs.every(j=>!reviewJobBody(reviewRecruitment(j)).body_complete));
});
for(const route of ['country','locations'])test('Workday '+route+' route does not call repeated or drifting pagination complete',async()=>{
 let page=0;const client=mock((q,m)=>m.purpose==='public_country_facet_discovery'?bootstrap:/job_list/.test(m.purpose)?++page===1?{total:3,jobPostings:[row('R1')]}:{total:2,jobPostings:[row('R1'),row('R2')]}:detail(q.url.endsWith('R1')?'R1':'R2'));
 const options={client,mode:'full',bootstrap:{data:{facets:locations}}};
 const r=route==='country'?await collectInternational(source,options):await collectWorkdayLocationFallback(source,options);
 assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.list_complete,false);
 assert.match(r.coverage.reason,/duplicate_job_ids/);assert.match(r.coverage.reason,/server_total_changed/);assert.equal(r.jobs.length,2);
});
test('Workday main route keeps earlier rows after pagination failure and counts only attempted detail failures',async()=>{
 let page=0;const client=mock((q,m)=>{if(m.purpose==='public_country_facet_discovery')return bootstrap;if(m.purpose==='job_list'){if(++page===2)throw Error('fixture later page failed');return {total:3,jobPostings:[row('R1'),row('R2')]};}if(q.url.endsWith('R2'))throw Error('fixture detail failed');return detail('R1');});
 const r=await collectInternational(source,{client,mode:'full'});
 assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.list_complete,false);assert.equal(r.jobs.length,2);
 assert.equal(r.coverage.details_failed,1);assert.equal(r.jobs.find(j=>j.job_id==='R1').body_complete,true);
 assert.equal(r.jobs.find(j=>j.raw_metadata?.observed_external_path===row('R2').externalPath).body_complete,false);
});
test('Nowcoder wrong employer cannot reappear after the same body enrichment used by campus',async()=>{
 const s={provider:'nowcoder_public',company_id:'expected',display_name:'Expected employer',api_config:{company_id:42}};
 const client=mock(()=>({code:0,data:{totalCount:1,datas:[{data:{id:'wrong-employer-job',companyId:99,jobName:'2027届校招软件工程师',recruitType:1,jobCityList:['上海'],ext:JSON.stringify({infos:'负责软件研发与测试，完成系统设计和维护，与产品团队协作落实业务需求。',requirements:'2027届应届毕业生，本科及以上学历，熟悉软件开发，具备良好沟通能力。'})}}]}}));
 const r=await collectOracleNowcoder(s,{client,mode:'full'});
 assert.equal(r.coverage.status,'partial');assert.deepEqual(r.jobs.map(j=>reviewJobBody(reviewRecruitment(j))),[]);
 assert.deepEqual(r.coverage.excluded_employer_rows.map(x=>[x.job_id,x.expected_company_id,x.returned_company_id]),[['wrong-employer-job',42,99]]);
 assert.equal(r.coverage.details_failed,0);
});
