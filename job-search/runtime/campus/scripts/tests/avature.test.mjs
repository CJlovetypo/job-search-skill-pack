import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAvatureList,collectAvature} from '../../../../../shared/job-search-core/scripts/lib/provider-avature.mjs';

const page='<a href="/careers/JobDetail/Test-Engineer/42">Test Engineer</a><a class="paginationNextLink" href="/careers/SearchJobs/?jobOffset=1">Next</a>';
test('Avature parses SearchJobs pages and never requests JobDetail',async()=>{
  const parsed=parseAvatureList(page,'https://jobs.example.com/careers/SearchJobs/?jobOffset=0');assert.equal(parsed.rows[0].id,'42');assert.match(parsed.next,/jobOffset=1/);const records=[];
  const result=await collectAvature({provider:'avature_public',company_id:'fixture',display_name:'Fixture',primary_entry_url:'https://jobs.example.com/careers/SearchJobs/?jobOffset=0',api_config:{origin:'https://jobs.example.com',search_path:'/careers/SearchJobs/'}},{client:{records,async request(q,{purpose}){const record={url:q.url,method:'GET',purpose,http_status:200,anonymous_session_from_scratch:true,response_sha256:'a'.repeat(64),response_file:'fixture'};records.push(record);return {text:q.url.includes('jobOffset=0')?page:'<a href="/careers/JobDetail/Other/43">Other</a>',record};}}});
  assert.equal(result.coverage.list_complete,true);assert.equal(result.jobs.length,2);assert.ok(records.every(x=>!x.url.includes('/JobDetail/')));
});
