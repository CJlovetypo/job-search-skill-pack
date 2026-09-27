import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePhenomBootstrap,collectPhenom} from '../../../../../shared/job-search-core/scripts/lib/provider-phenom.mjs';

const html='<script>var phApp = phApp || {"widgetApiEndpoint":"https://careers.example.com/widgets","country":"global","locale":"en_global","pageId":"page1"}; phApp.ddo = {};</script>';
test('Phenom enumerates the anonymous refineSearch list without job detail requests',async()=>{
  assert.equal(parsePhenomBootstrap(html).locale,'en_global');const records=[];
  const result=await collectPhenom({provider:'phenom_public',company_id:'fixture',display_name:'Fixture',primary_entry_url:'https://careers.example.com/global/en/search-results',api_config:{origin:'https://careers.example.com',search_path:'/global/en/search-results'}},{pageSize:100,client:{records,async request(q,{purpose}){const record={url:q.url,method:q.method||'GET',purpose,http_status:200,anonymous_session_from_scratch:true,response_sha256:'a'.repeat(64),response_file:'fixture'};records.push(record);if(purpose==='public_configuration_bootstrap')return {text:html,record};return {data:{refineSearch:{status:200,totalHits:1,data:{jobs:[{jobSeqNo:'1',title:'Engineer',city:'Shanghai',country:'China'}]}}},record};}}});
  assert.equal(result.coverage.list_complete,true);assert.equal(result.jobs.length,1);assert.equal(records.filter(x=>x.purpose==='job_list').length,1);assert.ok(records.every(x=>!String(x.url).includes('/job/')));
});
