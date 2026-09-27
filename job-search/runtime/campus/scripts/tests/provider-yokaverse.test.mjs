import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectYokaverse,normalizeYokaverseJob} from '../../../../../shared/job-search-core/scripts/lib/provider-yokaverse.mjs';

const source={provider:'yokaverse',company_id:'youka',display_name:'游卡',primary_entry_url:'https://campus.yokaverse.com/'};

test('Yokaverse inline JD maps stable IDs, type, locations and official detail URLs',()=>{
 const job=normalizeYokaverseJob({position_id:220,position_name:'UE',employment_type:1,location:['杭州'],description:'【岗位职责】\n参与产品设计。\n【岗位要求】\n2027届本科及以上学历。',position_type:'美术表现类'},source,'raw.json');
 assert.equal(job.job_id,'unknown-220');assert.equal(job.formal_status,'formal');assert.equal(job.body_complete,true);
 assert.deepEqual(job.cities,['杭州']);assert.equal(job.official_url,'https://campus.yokaverse.com/jobs/220');
});

test('Yokaverse collector paginates until unique IDs equal the server total',async()=>{
 const records=[],client={records,async request(q,meta){const page=Number(new URL(q.url).searchParams.get('page'));const record={http_status:200,response_file:`page-${page}.json`,purpose:meta.purpose};records.push(record);const rows=page===1?[1,2]:[3];return{record,data:{code:0,data:{total:3,list:rows.map(id=>({company:'youka',position_id:id,position_name:`Job ${id}`,employment_type:id===2?2:1,location:['上海'],description:'岗位职责：\n完成工作。\n岗位要求：\n本科及以上。'}))}}};}};
 const r=await collectYokaverse(source,{client,pageSize:2});
 assert.equal(r.coverage.status,'complete');assert.equal(r.coverage.pages,2);assert.equal(r.coverage.server_total,3);assert.equal(r.jobs.length,3);
 assert.equal(r.jobs.find(x=>x.job_id==='youka-2').formal_status,'internship');
});
