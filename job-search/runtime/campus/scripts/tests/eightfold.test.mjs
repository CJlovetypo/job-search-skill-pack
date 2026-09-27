import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEightfoldDomain,collectEightfold} from '../../../../../shared/job-search-core/scripts/lib/provider-eightfold.mjs';

const boot='<code id="pcsx-data">{&quot;domain&quot;:&quot;example.com&quot;}</code>';
test('Eightfold reads the employer domain and enumerates only the public list',async()=>{
  assert.equal(parseEightfoldDomain(boot),'example.com');const records=[];
  const result=await collectEightfold({provider:'eightfold_public',company_id:'fixture',display_name:'Fixture',primary_entry_url:'https://fixture.eightfold.ai/careers?domain=example.com',api_config:{origin:'https://fixture.eightfold.ai',domain:'example.com'}},{client:{records,async request(q,{purpose}){const record={url:q.url,method:q.method||'GET',purpose,http_status:200,anonymous_session_from_scratch:true,response_sha256:'a'.repeat(64),response_file:'fixture'};records.push(record);if(purpose==='public_configuration_bootstrap')return {text:boot,record};return {data:{status:200,data:{count:1,positions:[{id:7,name:'Engineer',locations:['Shanghai, China']}]}},record};}}});
  assert.equal(result.coverage.list_complete,true);assert.equal(result.jobs[0].job_id,'7');assert.equal(records.filter(x=>x.purpose==='job_list').length,1);assert.ok(records.every(x=>!String(x.url).includes('position_details')));
});
