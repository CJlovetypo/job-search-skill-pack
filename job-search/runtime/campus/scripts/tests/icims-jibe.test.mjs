import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeIcimsJibe} from '../../../../../shared/job-search-core/scripts/lib/providers-icims-jibe.mjs';
import {targetApiProof} from '../../../../../shared/job-search-core/scripts/lib/target-api-proof.mjs';

test('iCIMS Jibe normalization keeps public identity, China location, and body sections',()=>{
  const source={provider:'icims_jibe',company_id:'bissell',display_name:'BISSELL 必胜益康',primary_entry_url:'https://careers.bissell.com/jobs',api_config:{origin:'https://careers.bissell.com'}};
  const record={response_file:'raw/list.json'};
  const job=normalizeIcimsJibe({data:{slug:'8715',req_id:'8715',title:'Program Manager',description:'<p>Lead global product programs and cross-functional delivery.</p>',qualifications:'<p>Experience level: Minimum of 10 years professional experience.</p>',full_location:'Suzhou, China',city:'Suzhou',state:'Jiangsu',country:'China',country_code:'CN',employment_type:'FULL_TIME',language:'zh-cn',ats_code:'icims',meta_data:{canonical_url:'https://careers.bissell.com/jobs/8715?lang=zh-cn'}}},source,record);
  assert.equal(job.job_id,'8715');
  assert.equal(job.open_status,'open');
  assert.equal(job.formal_status,'social');
  assert.equal(job.body_complete,true);
  assert.ok(job.cities.includes('苏州'));
  assert.equal(job.official_url,'https://careers.bissell.com/jobs/8715?lang=zh-cn');
  assert.equal(job.recruitment_evidence.provider,'icims_jibe');
  assert.equal(targetApiProof(job,{...source,source_id:'bissell-public'},'social').accepted,true);
});
