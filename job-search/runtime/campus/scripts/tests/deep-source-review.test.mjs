import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {collectCommon} from '../lib/providers-common.mjs';
import {collectMicrosoft,collectSap,normalizeSapFeed,collectAmazon,normalizeAmazonJob} from '../lib/providers-global.mjs';
import {normalizeIvvaJob,normalizeIvvaResult} from '../lib/providers-ivva.mjs';
import {SKILL_ROOT} from '../lib/io.mjs';
const evidenceDir=name=>path.join(SKILL_ROOT,'artifacts/deep-source-review/tests',name);
const json=data=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
async function mock(fetcher,fn){const old=globalThis.fetch;globalThis.fetch=fetcher;try{return await fn();}finally{globalThis.fetch=old;}}
const fsOrigin='https://fixture.jobs.feishu.cn';
const fsJob={id:'fixture-1',title:'2027届软件工程师',description:'职责：开发测试企业服务，改善产品体验并协助团队排查生产故障。',requirement:'2027届本科及以上学历，具有软件工程基础，正式录用前需要提前实习三个月。',city_list:[{name:'武汉'}],job_post_info:{job_active_status:1}};
function fsSource(paths=['campus'],filter=['201']){
 return {company_id:'fixture-feishu',display_name:'测试公司',provider:'feishu',primary_entry_url:fsOrigin+'/campus',
 public_bootstrap_requests:paths.map(p=>({url:fsOrigin+'/api/v1/csrf/token',method:'POST',headers:{'website-path':p},body:{}})),
 validated_api_request_examples:paths.map(p=>({url:fsOrigin+'/api/v1/search/job/posts',method:'POST',headers:{'website-path':p,'portal-channel':'saas-career',Referer:fsOrigin+'/'+p},body:filter===undefined?{}:{recruitment_id_list:filter}}))};
}
test('显式全类型审计不被强制改回201，也不能借校招标题伪造正式类型',async()=>{
 const observed=[];
 await mock(async(url,init)=>{
  if(url.endsWith('/csrf/token'))return json({code:0,data:{token:'fixture-anon'}});
  observed.push(JSON.parse(init.body).recruitment_id_list);
  return json({code:0,data:{count:1,job_post_list:[fsJob]}});
 },async()=>{
  const all=await collectCommon(fsSource(['campus'],[]),{mode:'full',evidenceDir:evidenceDir('all-types')});
  assert.deepEqual(observed[0],[]);assert.equal(all.jobs[0].formal_status,'unknown');
  const campus=fsSource();delete campus.validated_api_request_examples[0].body.recruitment_id_list;
  const r=await collectCommon(campus,{mode:'full',evidenceDir:evidenceDir('default-campus')});
  assert.deepEqual(observed[1],['201']);assert.equal(r.jobs[0].formal_status,'formal');
  assert.match(r.jobs[0].requirements,/提前实习/);
 });
});
test('同域名不同招聘门户分别初始化和遍历，岗位ID去重',async()=>{
 const paths=[],boots=[];
 await mock(async(url,init)=>{
  const p=new Headers(init.headers).get('website-path');
  if(url.endsWith('/csrf/token')){boots.push(p);return json({code:0,data:{token:'anon-'+p}});}
  paths.push(p);assert.equal(new Headers(init.headers).get('x-csrf-token'),'anon-'+p);
  return json({code:0,data:{count:1,job_post_list:[fsJob]}});
 },async()=>{
  const r=await collectCommon(fsSource(['campus','current']),{mode:'full',evidenceDir:evidenceDir('portals')});
  assert.deepEqual(paths,['campus','current']);assert.deepEqual(boots,paths);
  assert.equal(r.jobs.length,1);assert.equal(r.coverage.contexts.length,2);
 });
});
const ms={company_id:'fixture-ms',display_name:'测试微软',provider:'microsoft_eightfold',primary_entry_url:'https://fixture.microsoft.com/careers',validated_api_request_examples:[{url:'https://fixture.microsoft.com/api/pcsx/search?location=China&start=0'},{url:'https://fixture.microsoft.com/api/pcsx/position_details?position_id=1'}]};
const msJob={id:'1',name:'Software Engineer',efcustomTextEmploymentType:['Full-Time'],locations:['Shanghai, China'],jobDescription:'Responsibilities: '+('Develop reliable software and work with other engineers. ').repeat(3)+'Qualifications: Bachelor degree, programming experience, communication skills, and systems knowledge.'};
test('微软重复分页保持部分覆盖，完整全文保留且全职不自动等于校招',async()=>{
 await mock(async url=>url.endsWith('/careers')?new Response('Public bootstrap'):url.includes('position_details')?json({status:200,data:msJob}):json({status:200,data:{count:2,positions:[{id:'1',name:msJob.name}]}}),async()=>{
  const r=await collectMicrosoft(ms,{maxPages:4,evidenceDir:evidenceDir('microsoft-repeat')});
  assert.equal(r.coverage.status,'partial');assert.equal(r.jobs.length,1);assert.equal(r.coverage.server_total,2);
  assert.equal(r.jobs[0].body_complete,true);assert.equal(r.jobs[0].formal_status,'unknown');
  assert.match(r.jobs[0].description,/Qualifications/);assert.equal(r.jobs[0].official_url,'https://fixture.microsoft.com/careers/job/1');
 });
});
test('微软详情缺正文不能伪装完整采集',async()=>{
 await mock(async url=>url.endsWith('/careers')?new Response('public'):url.includes('position_details')?json({status:200,data:{...msJob,jobDescription:''}}):json({status:200,data:{count:1,positions:[{id:'1'}]}}),async()=>{
  const r=await collectMicrosoft(ms,{evidenceDir:evidenceDir('microsoft-empty')});
  assert.equal(r.coverage.status,'partial');assert.equal(r.jobs[0].body_complete,false);
 });
});
const sap={company_id:'fixture-sap',display_name:'测试SAP',primary_entry_url:'https://jobs.sap.com/go/China/8807101/',validated_api_request_examples:[{url:'https://jobs.sap.com/services/rss/category/?catid=8807101'}]};
const rss='<rss version="2.0"><channel><item><title><![CDATA[Graduate Engineer (Shanghai, CN, 201203)]]></title><link>https://jobs.sap.com/job/Shanghai-Graduate/123/</link><description><![CDATA[<p>Responsibilities: '+('Build enterprise software with a collaborative team. ').repeat(3)+'</p><p>What you bring: Bachelor degree, programming knowledge and communication skills.</p><p>Career Status: Graduate | Employment Type: Regular Full Time</p>]]></description><pubDate>Sun, 06 Sep 2026 08:00:00 GMT</pubDate></item></channel></rss>';
test('SAP完整RSS只证明最新条目，始终部分覆盖且在招待核实',async()=>{
 await mock(async()=>new Response(rss,{status:200,headers:{'Content-Type':'application/rss+xml'}}),async()=>{
  const r=await collectSap(sap,{evidenceDir:evidenceDir('sap')});
  assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.server_total,null);assert.equal(r.coverage.list_complete,false);
  assert.equal(r.jobs[0].body_complete,true);assert.equal(r.jobs[0].formal_status,'formal');assert.equal(r.jobs[0].open_status,'unknown');assert.deepEqual(r.jobs[0].cities,['上海']);
 });
 assert.throws(()=>normalizeSapFeed('<html>Access denied</html>',sap,'fixture'),/channel/);
});
test('IVVA明确校招全职保留提前实习要求，字段不明确则待核实',()=>{
 const source={company_id:'fixture-ivva',display_name:'测试百图',primary_entry_url:'https://talent.biomap-inc.com/company/baitu/public-id'};
 const row={positionId:'123',positionName:'HR专员',positionNature:'全职',isSchoolRecruit:1,recruitStatus:1,workingPlace:'北京',_portal_token:'public-campus',_raw_file:'fixture.json',positionDesc:'职位描述：协助招聘、培训和员工关系工作，参与人力资源信息维护。职位要求：本科毕业，沟通能力良好，正式录用后要求提前实习三个月，每周至少四天。'};
 const j=normalizeIvvaJob(row,source);assert.equal(j.formal_status,'formal');assert.equal(j.body_complete,true);assert.match(j.requirements,/提前实习/);assert.match(j.official_url,/public-campus#\/positionDetail\?positionId=123&wt=1$/);
 assert.equal(normalizeIvvaJob({...row,isSchoolRecruit:null},source).formal_status,'unknown');
 assert.equal(normalizeIvvaJob({...row,positionNature:'实习'},source).formal_status,'internship');
});
test('IVVA列表完整但正文缺失时保留列表完整标记并降为部分覆盖',()=>{
 const source={company_id:'fixture-ivva',display_name:'测试公司',primary_entry_url:'https://talent.biomap-inc.com/company/baitu/public-id'};
 const r=normalizeIvvaResult({rows:[{positionId:'1',positionName:'测试岗',positionDesc:'',_portal_token:'public-campus'}],requests:[],coverage:{status:'complete',list_complete:true,reason:'unique_ids_reconcile_server_total'}},source);
 assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.list_complete,true);assert.deepEqual(r.coverage.missing_body_ids,['1']);
});
test('API实习与正文明确正式岗冲突时保留待核实，不直接排除',async()=>{
 const conflicting={...fsJob,title:'结构实习生',recruit_type:{id:'202',name:'实习',parent:{name:'校园招聘'}},description:'此岗位属于秋招正式岗，只考虑短期实习的同学请谨慎投递。负责产品结构设计与验证。'};
 await mock(async url=>url.endsWith('/csrf/token')?json({code:0,data:{token:'anon'}}):json({code:0,data:{count:1,job_post_list:[conflicting]}}),async()=>{
  const r=await collectCommon(fsSource(['campus'],[]),{mode:'full',evidenceDir:evidenceDir('type-conflict')});
  assert.equal(r.jobs[0].formal_status,'unknown');assert.match(r.jobs[0].recruitment_evidence.type_conflict.explicit_body_statement,/秋招正式岗/);
 });
});
test('亚马逊支持字母岗位ID与短资格字段，校招由全职和具体届次证据确认',async()=>{
 const s={company_id:'fixture-amazon',display_name:'测试亚马逊',primary_entry_url:'https://www.amazon.jobs/en/search?country=CHN',validated_api_request_examples:[{url:'https://www.amazon.jobs/en/search.json?country=CHN&offset=0'}]};
 const row={id:'uuid',job_path:'/en/jobs/SF123/',title:'2027 Campus Software Engineer',country_code:'CHN',location:'CN, Shanghai',description:'毕业时间：2027年应届毕业生。职责：'+('开发产品并与跨部门团队一起解决用户问题。').repeat(5),basic_qualifications:'本科',preferred_qualifications:'有相关项目经历优先。',job_schedule_type:'full-time',university_job:null,is_intern:null};
 const j=normalizeAmazonJob(row,s,'fixture');assert.equal(j.job_id,'SF123');assert.equal(j.body_complete,true);assert.equal(j.formal_status,'formal');
 assert.equal(normalizeAmazonJob({...row,title:'Software Engineer',description:'普通社会全职职责。'.repeat(20)},s,'fixture').formal_status,'unknown');
 const labelled=normalizeAmazonJob({...row,title:'Software Engineer',description:'开发维护系统。'.repeat(20),primary_search_label:'studentprograms.team-jobs-for-grads',job_schedule_type:null},s,'fixture');
 assert.equal(labelled.formal_status,'formal');assert.equal(labelled.recruitment_evidence.primary_search_label,'studentprograms.team-jobs-for-grads');
 await mock(async url=>json({hits:2,error:null,jobs:new URL(url).searchParams.get('offset')==='0'?[row]:[{...row,id:'uuid2',job_path:'/en/jobs/123/'}]}),async()=>{
  const r=await collectAmazon(s,{evidenceDir:evidenceDir('amazon-pages')});assert.equal(r.jobs.length,2);assert.equal(r.coverage.status,'complete');
 });
});
