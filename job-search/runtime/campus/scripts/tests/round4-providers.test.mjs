import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectRound4,normalizeMochr,normalizeHkc} from '../lib/providers-round4.mjs';

const source={company_id:'fixture',display_name:'甲单位',provider:'mochr_public',api_config:{employer_names:['甲单位']}};
const row={zpid:'campaign-1',zpgwid:'job-1',zpdwid:'employer-1',dwmc:'甲单位',gwmc:'专业技术岗',gwjj:'从事信息系统开发、维护和数据分析工作。',gwyq:'具备软件开发能力和良好沟通协作能力。',zpfwName:'应届毕业生',xlName:'研究生',xwName:'硕士及以上',zy:'计算机科学与技术'};

test('MOCHR normalization preserves structured body and explicit graduate scope',()=>{
 const job=normalizeMochr(source,row,'fixture.json',{ztmc:'2026年度公开招聘',zpzt:'报名已结束'});
 assert.equal(job.formal_status,'formal');assert.equal(job.open_status,'closed');assert.equal(job.body_complete,true);
 assert.match(job.description,/信息系统开发/);assert.match(job.requirements,/软件开发能力/);assert.equal(job.raw_metadata.employer_name,'甲单位');
});

test('MOCHR collector reconciles campaign total and filters exact employer',async()=>{
 const records=[];const client={records,async request(q,{purpose}){const record={http_status:200,response_file:purpose+'.json'};records.push({...record,url:q.url,purpose});
   if(purpose==='recruitment_campaign_list')return {record,data:{code:1,data:{total:1,value:[{id:'campaign-1',ztmc:'2026年度公开招聘',zpzt:'招聘已结束'}]}}};
   return {record,data:{code:1,data:{gwxxList:[row,{...row,zpgwid:'job-2',dwmc:'乙单位'}]}}};
 }};
 const result=await collectRound4(source,{client});
 assert.equal(result.coverage.status,'complete');assert.equal(result.coverage.list_complete,true);assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].job_id,'campaign-1:job-1');
});

test('HKC normalization uses campus category and splits a combined JD body',()=>{
 const job=normalizeHkc({...source,provider:'hkc_public'},{pkId:'hkc-1',name:'软件工程师',cityName:'广东省深圳市宝安区',companyName:'惠科股份有限公司',recruitCategory:'1',introduce:'岗位职责：负责软件系统开发、测试和维护，协同业务团队交付项目。\n任职要求：2027届本科及以上学历，熟悉软件开发，具备良好沟通能力。'},'fixture.json');
 assert.equal(job.formal_status,'formal');assert.equal(job.open_status,'open');assert.equal(job.body_complete,true);assert.deepEqual(job.cities,['深圳']);assert.match(job.requirements,/2027届/);
});
