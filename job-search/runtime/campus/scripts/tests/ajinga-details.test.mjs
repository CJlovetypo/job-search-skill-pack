import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectAjinga} from '../../../../../shared/job-search-core/scripts/lib/provider-ajinga.mjs';

const source={provider:'ajinga_public',company_id:'fixture',display_name:'Example',api_config:{company_id:'13999',root_company_id:'8190'}};
const row={pk:214866,title:'订单管理专员',company:{root_pk:8190,pk:13999,name:'Example Campus'},cities:['Shanghai'],is_overseas:false,url:'/job-detail-new/214866/c/',cant_applied:false,show_apply:1};
const content='<p>岗位职责</p><p>负责订单管理和跨部门协调，维护客户订单记录，持续跟进交付进度并协助解决业务问题。</p><p>任职要求</p><p>本科及以上学历，熟悉订单管理业务，具备良好的英语沟通能力和数据分析能力，能够独立完成日常工作。</p>';
function mock({mutate=()=>{},empty=false,status=200}={}){
 const records=[],requests=[];
 return {records,requests,async request(q,meta){
  requests.push({...q,purpose:meta.purpose});const record={http_status:meta.purpose==='job_detail'?status:200,response_file:'/fixture/'+meta.purpose+'.json',purpose:meta.purpose};records.push(record);
  let data;
  if(meta.purpose==='company_identity')data={code:200,data:{company:{id:13999,root_company:{id:8190}}}};
  else if(meta.purpose==='job_list')data={code:200,data:{count:empty?0:1,list:empty?[]:[structuredClone(row)]}};
  else {
   assert.equal(q.method??'GET','GET');
   assert.equal(q.url,'https://www.ajinga.com/django_rest/job-detail/info/214866/?job_id=214866&company_id=8190');
   data={code:200,data:{data:{company:{id:13999,root_company:{id:8190}},job:{id:214866,root_company_id:8190,cn_description:content}}}};mutate(data.data.data);
  }
  return {data,record};
 }};
}

test('AJINGA full mode binds GET detail to list requisition, channel and root before accepting real JD',async()=>{
 const client=mock(),r=await collectAjinga(source,{client,mode:'full'});
 assert.equal(r.coverage.status,'complete');assert.equal(r.coverage.list_complete,true);assert.equal(r.jobs.length,1);
 assert.equal(r.jobs[0].body_complete,true);assert.match(r.jobs[0].description,/订单管理和跨部门协调/);assert.match(r.jobs[0].requirements,/英语沟通能力/);
 assert.equal(r.jobs[0].raw_file,'/fixture/job_detail.json');assert.equal(r.jobs[0].list_raw_file,'/fixture/job_list.json');
 assert.equal(r.jobs[0].official_url,'https://www.ajinga.com/job-detail-new/214866/c/');assert.equal(r.jobs[0].open_status,'open');
 assert.equal(client.requests.filter(r=>r.purpose==='job_detail').length,1);
});

for(const [name,mutate] of [
 ['job ID',d=>d.job.id=999],['job root',d=>d.job.root_company_id=999],['company channel',d=>d.company.id=999],['company root',d=>d.company.root_company.id=999]
])test('AJINGA '+name+' mismatch retains published list row without trusting foreign detail',async()=>{
 const r=await collectAjinga(source,{client:mock({mutate}),mode:'full'});
 assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.list_complete,true);assert.equal(r.jobs.length,1);assert.equal(r.jobs[0].job_id,'214866');
 assert.equal(r.jobs[0].body_complete,false);assert.equal(r.jobs[0].description,null);assert.equal(r.jobs[0].raw_file,'/fixture/job_list.json');assert.match(r.jobs[0].detail_error,/mismatch/);
});

test('AJINGA list mode never fetches detail while empty full mode completes with zero detail requests',async()=>{
 for(const options of [{mode:'list',empty:false},{mode:'full',empty:true}]){
  const client=mock({empty:options.empty}),r=await collectAjinga(source,{client,mode:options.mode});
  assert.equal(r.coverage.status,'complete');assert.equal(client.requests.filter(r=>r.purpose==='job_detail').length,0);assert.equal(r.jobs.length,options.empty?0:1);
 }
});
test('AJINGA failed detail HTTP or truncated body keeps list coverage but never marks full collection complete',async()=>{
 for(const client of [mock({status:503}),mock({mutate:d=>d.job.cn_description='岗位职责：维护客户订单记录。'})]){
  const r=await collectAjinga(source,{client,mode:'full'});assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.list_complete,true);assert.equal(r.jobs[0].body_complete,false);
 }
});
