import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {reviewJobBody,extractRawBody} from '../lib/body-review.mjs';
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
test('explicit full-body list evidence remains available without relying on legacy true',()=>{
 const j={job_id:'1',description:body,evidence_files:['list.json'],detail_skipped_reason:'detail_limit'};
 const requests=[{purpose:'list_with_full_job_bodies',http_status:200,response_is_json:true,response_file:'list.json'}];
 assert.equal(reviewJobBody(j,{requests}).body_fetch.status,'available');
 assert.equal(reviewJobBody(j,{requests:[{...requests[0],purpose:'job_list'}]}).body_fetch.status,'not_attempted');
});
test('archived JSONP full body requires exact ID and is never executed',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'body-jsonp-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const raw=path.join(dir,'raw.txt');
 await fs.writeFile(raw,'jsoncallback('+JSON.stringify({resultbody:{jobid:'1',jobinfo:body}})+');');
 assert.equal(reviewJobBody({job_id:'1',raw_file:raw}).body_complete,true);
 assert.equal(reviewJobBody({job_id:'2',raw_file:raw}).body_complete,false);
 await fs.writeFile(raw,'jsoncallback({});globalThis.untrusted=true;');
 assert.equal(reviewJobBody({job_id:'1',raw_file:raw}).body_complete,false);assert.equal(globalThis.untrusted,undefined);
});

async function archive(t, records) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'body-evidence-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 return Promise.all(records.map(async (record,i)=>{
  const file=path.join(dir,`${i}.json`);await fs.writeFile(file,JSON.stringify(record));return file;
 }));
}

test('archived platform bodies support their original IDs and field names',async t=>{
 const duty='负责产品研发。',req='熟悉 Java。';
 const records=[
  {id:'1',positionDescription:body},
  {publishId:'1',workContent:duty,qualification:req},
  {id:'1',jobDuties:duty,jobRequirement:req},
  {jobUnionId:'1',jobDuty:duty,jobRequirement:req},
  {id:'1',postDuty:duty,jobRequirement:req},
  {id:'1',positionDescription:duty,positionRequirement:req},
  {pkId:'1',introduce:body},
 ];
 const files=await archive(t,records.map(r=>({data:{rows:[r]}})));
 for(const file of files){
  const reviewed=reviewJobBody({job_id:'1',evidence_files:[file]});
  assert.equal(reviewed.body_complete,true,file);
  assert.equal(reviewed.body_fetch.reason,'exact_id_official_body_fields');
  assert.equal(reviewed.body_review.sources[0].pointer,'/data/rows/0');
  assert.equal(reviewJobBody({job_id:'2',evidence_files:[file]}).body_complete,false);
 }
 assert.equal(extractRawBody({rows:[records[0],records[0]]},'1').error,'ambiguous_exact_id_records');
 assert.equal(extractRawBody({pkId:9007199254740992,introduce:body},'9007199254740992').error,'no_exact_id_record');
});

test('split legacy body is preserved without duplicating the archived whole body',async t=>{
 const [file]=await archive(t,[{id:'1',positionDescription:body}]);
 const original={job_id:'1',description:'岗位职责：\n负责产品研发。',requirements:'任职要求：\n熟悉 Java。'};
 const reviewed=reviewJobBody({...original,evidence_files:[file]});
 assert.equal(reviewed.description,original.description);assert.equal(reviewed.requirements,original.requirements);
 assert.deepEqual(reviewJobBody(reviewed),reviewed);
 assert.equal(reviewed.body_content_fingerprint,reviewJobBody({...original,body_fetch:job.body_fetch}).body_content_fingerprint);
});

test('Huawei intention requires matching advertisement, parent job and intention',async t=>{
 const files=await archive(t,[{data:{result:[{advertisementId:10,jobId:20}]}},{data:[{positionIntentionId:30,jobId:20,jobResponsibilities:'负责产品研发。',jobDemand:'熟悉 Java。'}]}]);
 const original={job_id:'10:30',evidence_files:files,recruitment_evidence:{provider:'huawei',advertisement_id:10,job_id:20,position_intention_id:30}};
 assert.equal(reviewJobBody(original).body_complete,true);
 for(const altered of [
  {evidence_files:[files[1]]},
  {job_id:'11:30',recruitment_evidence:{...original.recruitment_evidence,advertisement_id:11}},
  {job_id:'10:31',recruitment_evidence:{...original.recruitment_evidence,position_intention_id:31}},
  {recruitment_evidence:{...original.recruitment_evidence,job_id:21}},
 ])assert.equal(reviewJobBody({...original,...altered}).body_complete,false);
});

test('Yokaverse compound ID keeps companies with the same position number separate',async t=>{
 const [file]=await archive(t,[{rows:[{company:'alpha',position_id:3,description:body},{company:'beta',position_id:3,description:'公司介绍：欢迎加入'}]}]);
 const original={provider:'yokaverse',raw_file:file};
 assert.equal(reviewJobBody({...original,job_id:'alpha-3'}).body_complete,true);
 assert.equal(reviewJobBody({...original,job_id:'beta-3'}).body_complete,false);
 assert.equal(reviewJobBody({...original,job_id:'gamma-3'}).body_complete,false);
});

test('archived full list body survives a detail budget but cannot override summary or failed identity',async t=>{
 const [file]=await archive(t,[{Data:{DataResult:[{JobAdId:'1',Duty:body}]}}]);
 const original={job_id:'1',list_raw_file:file,description:body};
 const reviewed=reviewJobBody({...original,detail_error:'maintenance_detail_budget_exhausted'});
 assert.equal(reviewed.body_complete,true);assert.equal(reviewed.body_fetch.status,'available');
 for(const extra of [{body_is_summary:true},{detail_error:'ID mismatch'},{detail_error:'HTTP 500'}]){
  const result=reviewJobBody({...original,...extra});assert.equal(result.body_complete,false);
  assert.notEqual(result.body_fetch.status,'available');
 }
 assert.equal(reviewJobBody({...original,job_id:'2',detail_error:'maintenance_detail_budget_exhausted'}).body_complete,false);
});
