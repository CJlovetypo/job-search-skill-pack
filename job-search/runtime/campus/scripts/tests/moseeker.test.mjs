import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMoseekerList,collectMoseeker} from '../../../../../shared/job-search-core/scripts/lib/provider-moseeker.mjs';

const page=(companyId,total,positions)=>`<html><title>测试公司招聘</title><textarea id="position-data">${JSON.stringify({companyId:String(companyId),total,positions}).replaceAll('"','&quot;')}</textarea></html>`;

test('MoSeeker parses the structured company list without reading job details',async()=>{
  const parsed=parseMoseekerList(page(123,2,[{name:'工程师',href:'/position/index/pid/10',shortCities:'上海'},{name:'实习生',href:'/position/index/pid/11',shortCities:'北京'}]));
  assert.equal(parsed.company_id,'123');assert.equal(parsed.total,2);assert.equal(parsed.positions.length,2);
  const requests=[];
  const result=await collectMoseeker({provider:'moseeker_public',company_id:'fixture',display_name:'测试公司',primary_entry_url:'https://www.moseeker.com/positions/index/cid/123',api_config:{company_id:'123'}},{client:{records:requests,async request(q,{purpose}){requests.push({url:q.url,method:'GET',purpose,http_status:200,anonymous_session_from_scratch:true,response_sha256:'a'.repeat(64),response_file:'fixture.html'});return {text:page(123,2,[{name:'工程师',href:'/position/index/pid/10',shortCities:'上海'},{name:'实习生',href:'/position/index/pid/11',shortCities:'北京'}]),record:requests.at(-1)};}}});
  assert.equal(result.coverage.list_complete,true);assert.equal(result.coverage.server_total,2);assert.equal(result.jobs.length,2);assert.equal(requests.length,1);assert.ok(requests.every(x=>x.purpose==='job_list'));
});
