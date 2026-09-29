import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewJobBody} from '../lib/body-review.mjs';
import {bodyCacheReusable,needsBodyFetch} from '../lib/body-fetch.mjs';
import {jobFingerprint} from '../lib/job-version.mjs';
const body='岗位职责：\n负责产品研发。\n任职要求：\n熟悉 Java。';
const job={job_id:'1',company_id:'a',description:body,requirements:'',body_fetch:{status:'available',origin:'detail',reason:'fixture_official_body'}};
test('body v2 is idempotent and rejects a legacy true without acquisition evidence',()=>{
 const once=reviewJobBody(job),twice=reviewJobBody(once);
 assert(once.body_complete);assert.deepEqual(twice,once);
 const legacy=reviewJobBody({job_id:'1',description:body,body_complete:true});
 assert.equal(legacy.body_complete,false);assert.equal(legacy.body_fetch.status,'unknown');
 assert.equal(legacy.body_review.sections.requirements,'identified');
});
test('available duties without recognized qualifications do not cause refetch',()=>{
 const j=reviewJobBody({...job,description:'What you will do\nBuild reliable systems.'});
 assert.equal(j.body_complete,false);assert.equal(j.body_review.sections.requirements,'not_identified');
 assert.equal(needsBodyFetch(j),false);assert(bodyCacheReusable({coverage:{status:'partial',list_complete:true},jobs:[j]}));
 assert.equal(bodyCacheReusable({coverage:{status:'partial'},jobs:[j]}),false);
});
test('summary, budget and identity errors cannot be promoted by content',()=>{
 for(const [extra,status] of [[{body_is_summary:true},'partial'],[{body_fetch:undefined,detail_skipped_reason:'detail_limit'},'not_attempted'],[{detail_error:'ID mismatch'},'failed']]){
  const j=reviewJobBody({...job,...extra});assert.equal(j.body_complete,false);assert.equal(j.body_fetch.status,status);
 }
 const j=reviewJobBody({...job,body_fetch:undefined,raw_file:'fixture-detail.json'},{requests:[{purpose:'job_detail',http_status:200,response_is_json:true,response_file:'fixture-detail.json'}]});
 assert.equal(j.body_fetch.status,'available');assert(j.body_complete);
});
test('old manual method names do not bypass review; parser version invalidates assessment',()=>{
 const j=reviewJobBody({...job,description:'公司介绍：欢迎加入',requirements:'',body_complete:true,body_review:{method:'manual_full_record_review'}});
 assert.equal(j.body_complete,false);
 const a=reviewJobBody(job);assert.notEqual(jobFingerprint(a),jobFingerprint({...a,body_review:{...a.body_review,version:3}}));
 assert.equal(jobFingerprint(a),jobFingerprint({...a,body_review:{...a.body_review,input_sha256:'different response metadata'}}));
});
