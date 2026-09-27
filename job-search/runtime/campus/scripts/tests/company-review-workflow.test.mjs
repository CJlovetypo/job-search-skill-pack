import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {REVIEW_POLICY_VERSION,reviewHash,scoreAssessment,routeGap,REVIEW_GATES} from '../../../../../shared/job-search-core/scripts/lib/company-review-policy.mjs';
import {researchQueue,validateReview,contentHash,campaignProgress,mergePublishedReview} from '../../../../../shared/job-search-core/scripts/lib/company-records.mjs';
import {patchReviewedFields,validateApprovalManifest} from '../../../../../shared/job-search-core/scripts/lib/company-review-publication.mjs';
import {commitPublication,recoverPublication,withPublicationLock,committedPublication} from '../../../../../shared/job-search-core/scripts/lib/company-publication-transaction.mjs';
import {verifyReviewEvidence,bytesHash} from '../../../../../shared/job-search-core/scripts/lib/company-evidence.mjs';
import {evaluateCalibration,verifyCalibrationSources} from '../../../../../shared/job-search-core/scripts/lib/company-review-calibration.mjs';
import {STATIC_FIELDS} from '../../../../../shared/job-search-core/scripts/lib/company-records.mjs';
import {assertIndependentReviewsUnchanged} from '../../../../../shared/job-search-core/scripts/lib/public-company-data.mjs';

const now='2026-09-26T12:00:00.000Z',old='2026-09-20T12:00:00.000Z';
const campaign=()=>researchQueue({companies:[{company_id:'a',display_name:'Synthetic'}]},{campaignId:'new',startedAt:'2026-09-26T00:00:00.000Z',reuseEvidence:true});
function review(){const content='Source: open(https://example.com/about) Synthetic provides hardware.';return {company_id:'a',campaign_id:'new',reviewed_at:now,identity_reason:'Synthetic official identity',searches:[],documents:[{id:'d',url:'https://example.com/about',title:'Synthetic',content,entity:'Synthetic',identity_basis:'Explicit entity',fetched_at:old,tool:'builtin',read_kind:'page_body',sha256:contentHash(content),raw_archive:'capture.json',raw_sha256:'0'.repeat(64),applicability_reason:'The disclosed product description remains applicable to the claimed time.'}],decisions:{'descriptions.products_services':{status:'verified',value:'Hardware',entity:'Synthetic',reason:'Explicit product disclosure',checked_at:now,citations:[{document_id:'d',excerpt:'provides hardware'}]}}};}
function assessment(d,grades={I:25,D:30,A:20,T:15,C:10}) {return {policy_version:REVIEW_POLICY_VERSION,reviewer:'test reviewer',reviewed_at:now,sensitive_claims:false,decision_hash:reviewHash(d),dimensions:Object.fromEntries(Object.entries(grades).map(([k,score])=>[k,{score,reason:'Synthetic cited evidence',document_ids:['d']}])),checks:Object.fromEntries(REVIEW_GATES.map(k=>[k,{pass:true,reason:'Checked synthetic '+k}])),claims:[{text:d.value,supported:true,document_ids:['d']}]};}

test('archived evidence can be reviewed without a new search, with real old dates retained',()=>{
 const r=review();assert(validateReview(r,campaign(),{now}));assert.equal(r.documents[0].fetched_at,old);
 const edits=[r=>r.reviewed_at=old,r=>r.documents[0].raw_sha256='',r=>r.documents[0].applicability_reason='',r=>r.documents[0].fetched_at='2027-01-01',r=>r.decisions['descriptions.products_services'].checked_at=old];
 for(const edit of edits){const bad=review();edit(bad);assert.throws(()=>validateReview(bad,campaign(),{now}));}
});
test('scores require supported grades and matching evidence; 90 cannot compensate for a conflict',()=>{
 const d=review().decisions['descriptions.products_services'],a=assessment(d);
 assert.equal(scoreAssessment('descriptions.products_services',a,{decision:d,documentIds:['d']}).total,100);
 a.dimensions.C.score=0;a.checks.conflicts.pass=false;
 const conflict=scoreAssessment('descriptions.products_services',a,{decision:d,documentIds:['d']});assert.equal(conflict.total,90);assert.equal(conflict.eligible,false);
 for(const edit of [a=>a.dimensions.I.score=24,a=>a.dimensions.D.document_ids=['other'],a=>a.claims[0].supported=false,a=>a.decision_hash='wrong',a=>delete a.sensitive_claims]){const bad=assessment(d);edit(bad);assert.equal(scoreAssessment('descriptions.products_services',bad,{decision:d,documentIds:['d']}).eligible,false);}
 const general=assessment(d,{I:20,D:30,A:15,T:10,C:10});assert.equal(scoreAssessment('descriptions.products_services',general,{decision:d,documentIds:['d']}).eligible,true);
 assert.equal(scoreAssessment('tags.headquarters_country',general,{decision:d,documentIds:['d']}).eligible,false);
});
test('classification problems remain local; known URLs open directly; exhausted gaps stop',()=>{
 assert.equal(routeGap({reason:'classification_ambiguity',explanation:'Two definitions overlap'}).network_required,false);
 assert.throws(()=>routeGap({reason:'missing_fact',explanation:'Need evidence'}),/Network task/);
 const gap={reason:'missing_body',explanation:'Have URL only',missing_fact:'Product description',acceptance:'Relevant page body',checked_evidence_ids:[],stop_condition:'Body acquired or two attempts complete',known_url:'https://example.com/about'};
 assert.equal(routeGap(gap).action,'open_known_url');assert.equal(routeGap(gap,{rounds:2}).network_required,false);
 assert.throws(()=>routeGap({...gap,reason:'material_conflict'}),/locally/);
});
test('placeholder unresolved rows never imply completed static research',()=>{
 const r=review(),c=campaign();for(const f of c.required_fields)r.decisions[f]={status:'unresolved',value:null,entity:'Synthetic',reason:'No body yet',checked_at:now,citations:[]};
 assert.equal(campaignProgress(c,{companies:[r]}).static_complete,0);
});
test('partial publication preserves unrelated fields, source repairs, cities and other companies',()=>{
 const row={company_id:'a',tags:{organization_size:'小厂',ownership:'私企',recruitment:{social:{cities:['北京']}}},descriptions:{products_services:'old',customers:'keep'},sources:[{url:'https://new.example/jobs'}],governance:{fields:{'descriptions.products_services':{status:'unknown'},'descriptions.customers':{status:'verified'},'tags.organization_size':{status:'classified'}}}};
 const current={generated_at:old,companies:[row,{...structuredClone(row),company_id:'b'}]},generated=structuredClone(current);generated.generated_at=now;
 generated.companies[0].descriptions.products_services='new';generated.companies[0].governance.fields['descriptions.products_services']={status:'verified'};generated.companies[0].sources=[];generated.companies[0].descriptions.customers='unwanted';generated.companies[0].tags.recruitment.social.cities=[];
 const {records,changes}=patchReviewedFields(current,generated,[{company_id:'a',fields:['descriptions.products_services']}]);
 assert.equal(changes.length,1);assert.deepEqual(records.companies[0].sources,row.sources);assert.deepEqual(records.companies[0].tags,row.tags);assert.equal(records.companies[0].descriptions.customers,'keep');assert.deepEqual(records.companies[1],current.companies[1]);assert.equal(current.companies[0].descriptions.products_services,'old');
});
test('approval binds actual decision, complete review and policy; no legacy manifest bypass',()=>{
 const r=review(),c=campaign(),field='descriptions.products_services';const a={schema_version:2,policy_version:REVIEW_POLICY_VERSION,campaign_hash:reviewHash(c),reviewer:'reviewer',mode:'pilot',fields:[{company_id:'a',field,review_hash:reviewHash(r),assessment:assessment(r.decisions[field])}]};
 assert.equal(validateApprovalManifest(a,c,[r],{now}).length,1);
 r.documents[0].applicability_reason+=' changed';assert.throws(()=>validateApprovalManifest(a,c,[r],{now}),/changed/);
 assert.throws(()=>validateApprovalManifest({schema_version:1},c,[r],{now}),/changed/);
});
test('field assessment metadata survives a subsequent partial review',()=>{
 const r=review();r.field_assessments={'descriptions.products_services':{score:95}};const n=review();n.campaign_id='next';n.decisions={'descriptions.customers':{...r.decisions['descriptions.products_services'],value:'customers'}};n.field_assessments={'descriptions.customers':{score:90}};
 assert.deepEqual(mergePublishedReview(r,n).field_assessments,{...r.field_assessments,...n.field_assessments});
});
test('publication interruption is recoverable and refuses external edits or simultaneous writers',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'company-tx-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const a=path.join(root,'a.json'),b=path.join(root,'b.json'),journal=path.join(root,'journals');await fs.writeFile(a,'old a');await fs.writeFile(b,'old b');
 await assert.rejects(commitPublication([{file:a,bytes:'new a'},{file:b,bytes:'new b'}],{root:journal,faultAfter:1}),/interruption/);
 assert.equal(await fs.readFile(a,'utf8'),'new a');assert.equal(await fs.readFile(b,'utf8'),'old b');
 await assert.rejects(commitPublication([{file:b,bytes:'another'}],{root:journal}),/recover/);
 await fs.writeFile(b,'external');await assert.rejects(recoverPublication({root:journal,allowedTargets:[a,b]}),/concurrent/);
 await fs.writeFile(b,'old b');const recovered=await recoverPublication({root:journal,allowedTargets:[a,b]});assert.equal(recovered.readback_verified,true);assert.equal(await fs.readFile(b,'utf8'),'new b');
 await assert.rejects(commitPublication([{file:a,bytes:'bad',expected:bytesHash('old a')}],{root:journal}),/changed/);
 let release;const held=withPublicationLock(()=>new Promise(resolve=>{release=resolve;}),{root:journal});
 while(!release)await new Promise(resolve=>setTimeout(resolve,1));
 await assert.rejects(withPublicationLock(async()=>{}, {root:journal}),/locked/);release();await held;
});
test('evidence verifier rejects manufactured bodies, wrong source URL and search-only responses',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'company-evidence-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const dir=path.join(root,'datasets/web-search/builtin/run/raw');await fs.mkdir(dir,{recursive:true});
 const file=path.join(dir,'raw.json'),r=review(),bytes=JSON.stringify(r.documents[0].content);await fs.writeFile(file,bytes);r.documents[0].raw_archive=file;r.documents[0].raw_sha256=bytesHash(bytes);
 assert.equal((await verifyReviewEvidence(r,{root,readLedger:false})).length,1);
 r.documents[0].content+=' fabricated';r.documents[0].sha256=contentHash(r.documents[0].content);await assert.rejects(verifyReviewEvidence(r,{root,readLedger:false}),/not present/);
 const actual=review(),doc=actual.documents[0],otherUrl='https://other.example/about';
 const batch=JSON.stringify(doc.content+'\n---\nSource: open('+otherUrl+') Other company body.');await fs.writeFile(file,batch);
 doc.raw_archive=file;doc.raw_sha256=bytesHash(batch);doc.url=otherUrl;
 await assert.rejects(verifyReviewEvidence(actual,{root,readLedger:false}),/does not match/,'A different URL in the same request cannot authenticate this body');
 doc.url='https://example.com/about';doc.content='Search results for Synthetic '+doc.url;doc.sha256=contentHash(doc.content);
 const search=JSON.stringify(doc.content);await fs.writeFile(file,search);doc.raw_sha256=bytesHash(search);
 await assert.rejects(verifyReviewEvidence(actual,{root,readLedger:false}),/not a page-body/);
});

test('calibration recomputes precision, rejects overlap and cannot trust a self-declared pass',()=>{
 assert.throws(()=>evaluateCalibration({schema_version:1,policy_version:REVIEW_POLICY_VERSION,status:'passed'}),/dataset/);
 const samples=[];
 for(const split of ['calibration','test'])for(const field of STATIC_FIELDS)for(let i=0;i<(split==='test'?30:20);i++) {
   const d={...review().decisions['descriptions.products_services'],as_of:'2026-09-20'},a=assessment(d);a.size_eligible=false;
   samples.push({company_id:split+'-'+i,field,split,decision:d,assessment:a,document_ids:['d'],reference:{reviewer:'separate test fixture reviewer',blinded:true,reviewed_at:now,decision_hash:reviewHash(d),acceptable:true,hard_gate_error:false,reason:'Synthetic reference confirms the claim',document_ids:['d']}});
 }
 const dataset={schema_version:1,policy_version:REVIEW_POLICY_VERSION,samples};
 const good=evaluateCalibration(dataset);assert.equal(good.status,'passed');assert.equal(good.accepted,360);assert.ok(good.wilson_95_lower<1);
 const missed=samples.find(x=>x.split==='test');missed.reference.acceptable=false;
 assert.equal(evaluateCalibration(dataset).status,'not_passed','A weak field is not hidden by other correct fields');
 missed.reference.acceptable=true;missed.reference.hard_gate_error=true;assert.equal(evaluateCalibration(dataset).hard_gate_errors,1);
 missed.reference.hard_gate_error=false;missed.company_id='calibration-0';assert.throws(()=>evaluateCalibration(dataset),/overlap|duplicated/);
});

test('interrupted publication can roll back after source drift and committed plans are not replayed',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'company-rollback-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const a=path.join(root,'a'),b=path.join(root,'b'),source=path.join(root,'source'),journals=path.join(root,'journals');
 await fs.writeFile(a,'old');await fs.writeFile(source,'original');
 await assert.rejects(commitPublication([{file:a,bytes:'new'},{file:b,bytes:'created'}],{root:journals,inputs:{[source]:bytesHash('original')},faultAfter:2}),/interruption/);
 await fs.writeFile(source,'changed');await assert.rejects(recoverPublication({root:journals,allowedTargets:[a,b]}),/input changed/);
 assert.equal((await recoverPublication({root:journals,allowedTargets:[a,b],rollback:true})).status,'rolled_back');
 assert.equal(await fs.readFile(a,'utf8'),'old');await assert.rejects(fs.stat(b),{code:'ENOENT'});
 const committed=await commitPublication([{file:a,bytes:'final'}],{root:journals,metadata:{plan_hash:'fixed-plan'}});
 assert.equal((await committedPublication('fixed-plan',{root:journals})).id,committed.id);
 await fs.writeFile(a,'later');await assert.rejects(committedPublication('fixed-plan',{root:journals}),/already published/);
});

test('other publication channels cannot add, downgrade or delete independently reviewed fields',()=>{
 const row={company_id:'a',descriptions:{products_services:'hardware'},governance:{fields:{'descriptions.products_services':{origin:'fresh_web_review',status:'verified'}}}},current={companies:[row]};
 assert.doesNotThrow(()=>assertIndependentReviewsUnchanged(current,structuredClone(current)));
 for(const edit of [r=>r.companies[0].governance.fields['descriptions.products_services'].origin='api_search',r=>r.companies[0].descriptions.products_services='different',r=>r.companies=[]]){const changed=structuredClone(current);edit(changed);assert.throws(()=>assertIndependentReviewsUnchanged(current,changed),/approved field/);}
 assert.throws(()=>assertIndependentReviewsUnchanged({companies:[]},current),/approved field/);
});

test('calibration source verification rejects invented samples and altered original timestamps',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'company-calibration-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'datasets','fixtures');await fs.mkdir(dir,{recursive:true});const r=review(),d=r.documents[0],raw=path.join(dir,'raw.json');
 const bytes=JSON.stringify({company_id:r.company_id,checked_at:d.fetched_at,fetch_url_results:[{contents:[{url:d.url,content:d.content}]}]});await fs.writeFile(raw,bytes);d.raw_archive=raw;d.raw_sha256=bytesHash(bytes);
 const file=path.join(dir,'review.json'),body=JSON.stringify(r);await fs.writeFile(file,body);
 const dataset={samples:[{company_id:r.company_id,field:'descriptions.products_services',decision:r.decisions['descriptions.products_services'],document_ids:['d'],review_file:file,review_sha256:bytesHash(body)}]};
 assert.equal(Object.keys(await verifyCalibrationSources(dataset,{root})).length,2);
 const alias=structuredClone(r);alias.company_id='b';const aliasRaw=path.join(dir,'alias-raw.json');
 const aliasBytes=JSON.stringify({...JSON.parse(bytes),company_id:'b'});await fs.writeFile(aliasRaw,aliasBytes);alias.documents[0].raw_archive=aliasRaw;alias.documents[0].raw_sha256=bytesHash(aliasBytes);
 const aliasFile=path.join(dir,'alias-review.json'),aliasReviewBytes=JSON.stringify(alias);await fs.writeFile(aliasFile,aliasReviewBytes);
 const overlap={samples:[{...dataset.samples[0],split:'calibration'},{...dataset.samples[0],company_id:'b',split:'test',review_file:aliasFile,review_sha256:bytesHash(aliasReviewBytes)}]};
 await assert.rejects(verifyCalibrationSources(overlap,{root}),/page body overlaps/,'Different IDs cannot put the same source body in both calibration and test');
 const bad=structuredClone(dataset);delete bad.samples[0].review_sha256;await assert.rejects(verifyCalibrationSources(bad,{root}),/hashed source/);
 d.fetched_at=now;const changed=JSON.stringify(r);await fs.writeFile(file,changed);dataset.samples[0].review_sha256=bytesHash(changed);await assert.rejects(verifyCalibrationSources(dataset,{root}),/capture time/);
});

test('size is derived from preserved formal dependencies, and unresolved scoring cannot complete research',()=>{
 const row={company_id:'a',identity:{display_name:'Synthetic'},tags:{ownership:'私企',organization_size:'小厂'},descriptions:{workforce:'800名员工'},governance:{fields:{'tags.ownership':{status:'verified',origin:'fresh_web_review'},'descriptions.workforce':{status:'verified',as_of:'2026-01-01',evidence:[{url:'https://example.com'}],origin:'fresh_web_review'},'tags.organization_size':{status:'classified'}}}};
 const current={companies:[row]},generated=structuredClone(current);generated.generated_at=now;generated.companies[0].descriptions.workforce='8000名员工';generated.companies[0].tags.organization_size='大厂';
 const patch=patchReviewedFields(current,generated,[{company_id:'a',fields:['tags.ownership']}]);assert.equal(patch.records.companies[0].tags.organization_size,'中厂');assert.equal(patch.records.companies[0].descriptions.workforce,'800名员工');
 const denied=patchReviewedFields(current,generated,[{company_id:'a',fields:['tags.ownership'],size_eligible:false}]);assert.equal(denied.records.companies[0].tags.organization_size,'待核实');
 const r=review(),c=campaign();c.companies[0].requested_fields=['descriptions.products_services'];assert.equal(campaignProgress(c,{companies:[r]}).static_complete,0);
 r.field_assessments={'descriptions.products_services':assessment(r.decisions['descriptions.products_services'])};assert.equal(campaignProgress(c,{companies:[r]}).static_complete,1);
 r.field_assessments['descriptions.products_services'].checks.identity.pass=false;assert.equal(campaignProgress(c,{companies:[r]}).static_complete,0);
});
