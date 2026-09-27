import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectHuatie} from '../../../../../shared/job-search-core/scripts/lib/provider-huatie.mjs';
const source={company_id:'fixture-huatie',display_name:'华铁',api_config:{page_size:2}};
const row=(id,source=2)=>({id,source,status:1,title:'机械工程师',address:'杭州',description:'负责机械设备维护与现场故障处理，协助团队制定并实施设备巡检计划。',requirements:'本科及以上学历，机械相关专业，具有良好的沟通能力，熟悉设备维护与安全规范。'});
function client(pages){return {records:[],async request({url}){this.records.push({url});return {data:{code:200,data:pages.shift()},record:{http_status:200}};}};}
test('Huatie native query preserves channel and reconciles distinct pagination',async()=>{
  const c=client([{list:[row(1),row(2)],pager:{current:1,size:2,total:3}},{list:[row(3)],pager:{current:2,size:2,total:3}}]);
  const r=await collectHuatie(source,{client:c,targetMode:'campus',keyword:'工程师',mode:'list'});
  assert.equal(r.coverage.status,'complete');assert.deepEqual(r.jobs.map(j=>j.job_id),['1','2','3']);
  assert.equal(r.jobs[0].formal_status,'formal');assert.equal(r.jobs[0].official_url,'https://www.zjhuatie.cn/join/detail?id=1');
  for(const q of c.records){const u=new URL(q.url);assert.equal(u.searchParams.get('keywords'),'工程师');assert.equal(u.searchParams.get('source'),'2');assert.equal(u.searchParams.get('status'),'1');}
});
test('Huatie refuses repeated pagination and rows leaking another channel',async()=>{
  const repeated=client([{list:[row(1),row(2)],pager:{current:1,size:2,total:4}},{list:[row(1),row(2)],pager:{current:2,size:2,total:4}}]);
  assert.equal((await collectHuatie(source,{client:repeated,mode:'list'})).coverage.list_complete,false);
  const wrong=client([{list:[row(1,1)],pager:{current:1,size:2,total:1}}]);
  const r=await collectHuatie(source,{client:wrong});assert.equal(r.coverage.status,'failed');assert.equal(r.jobs.length,0);
});
test('Huatie empty native result is complete only in an established channel',async()=>{
  const empty=()=>client([{list:[],pager:{current:1,size:2,total:0}}]);
  assert.equal((await collectHuatie(source,{client:empty(),targetMode:'social'})).coverage.status,'complete');
  const r=await collectHuatie(source,{client:empty(),targetMode:'internship'});assert.equal(r.coverage.status,'partial');assert.match(r.coverage.reason,/No dedicated internship/);
});
