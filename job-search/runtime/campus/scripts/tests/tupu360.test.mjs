import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectTupu360} from '../../../../../shared/job-search-core/scripts/lib/provider-tupu360.mjs';

test('Tupu360 enumerates all public recruitment channels without job detail requests',async()=>{
  const records=[];
  const client={records,async request(q,meta){
    const u=new URL(q.url),type=u.searchParams.get('type'),rows=type==='SOCIALRECRUITMENT'?[{pid:'s1',pName:'工程师',pCity:'上海',recruitmentType:type,bStop:false}]:type==='INTERNSHIPRECRUITMENT'?[{pid:'i1',pName:'实习生',pCity:'北京',recruitmentType:type,bStop:false}]:[];
    const record={http_status:200,response_file:'fixture-'+records.length,purpose:meta.purpose,response_sha256:'a'.repeat(64),anonymous_session_from_scratch:true};records.push(record);
    return {data:{code:'0',result:{total:rows.length,positions:rows}},record};
  }};
  const result=await collectTupu360({company_id:'acme',display_name:'Acme',provider:'tupu360',primary_entry_url:'https://acme.tupu360.com/',api_config:{origin:'https://acme.tupu360.com'}},{client,pageSize:200,maxPages:2});
  assert.equal(result.coverage.list_complete,true);assert.equal(result.jobs.length,2);assert.equal(records.length,3);assert.ok(records.every(x=>x.purpose==='job_list'));assert.ok(result.jobs.every(x=>x.body_complete===false));
  assert.deepEqual(new Set(result.jobs.map(x=>x.formal_status)),new Set(['social','internship']));
});
