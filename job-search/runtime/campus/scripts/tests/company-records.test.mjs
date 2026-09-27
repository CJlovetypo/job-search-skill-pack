import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {researchQueue,validateReview,contentHash,buildCompanyRecords,projectCompanyRecords,campaignProgress,STATIC_FIELDS} from '../../../../../shared/job-search-core/scripts/lib/company-records.mjs';
import {archiveStructuredField,summarizeCandidates} from '../../../../../shared/job-search-core/scripts/archive-company-research.mjs';
import {ownershipDisplayTag} from '../../../../../shared/job-search-core/scripts/lib/ownership.mjs';
import {validApiValue,buildApiPublication} from '../../../../../shared/job-search-core/scripts/publish-api-company-labels.mjs';
import {PACK_ROOT} from '../../../../../shared/job-search-core/runtime-context.mjs';

const now='2026-09-23T01:00:00.000Z',startedAt='2026-09-23T00:00:00.000Z';
const inputs=()=>({registry:{companies:[{company_id:'a',display_name:'Synthetic',industry_tags:['internet'],primary_entry_url:'https://example.com/jobs'}]},
 business:{companies:[{company_id:'a',business_tags:['游戏'],business_summary:'旧描述',status:'verified'}]},
 ownership:{companies:[{company_id:'a',ownership_tag:'私企',status:'verified'}]},
 profiles:{companies:[{company_id:'a',workforce:{value:'8000人',status:'verified',entity:'公司',as_of:'2026-01-01',evidence:[{url:'https://example.com/report'}]}}]},
 size:{companies:[{company_id:'a',label:'小厂',ownership_tag:'国企'}]},cities:{campus:{companies:[{company_id:'a',cities:['北京'],city_coverage_complete:false}]}},reviews:{companies:[]}});
const campaign=()=>researchQueue(inputs().registry,{campaignId:'c',startedAt,vocabulary:['网络安全','游戏']});
function review() {
 const content='Synthetic provides cybersecurity products. Owned by private shareholders.';
 return {company_id:'a',campaign_id:'c',identity_reason:'Official name matches recruitment portal',
 searches:[{query:'Synthetic official company products shareholders',tool:'web.run',searched_at:now,status:'success',result_urls:['https://example.com/about']}],
 documents:[{id:'doc',url:'https://example.com/about',title:'About',content,sha256:contentHash(content),entity:'Synthetic',identity_basis:'Company name matches',fetched_at:now,tool:'web.run',read_kind:'page_body'}],
 decisions:{'tags.business':{value:['网络安全'],status:'verified',reason:'Official product disclosure',entity:'Synthetic',checked_at:now,citations:[{document_id:'doc',excerpt:'provides cybersecurity products'}]},
 'descriptions.business_summary':{value:'提供网络安全产品',status:'verified',reason:'官方产品页',entity:'Synthetic',checked_at:now,citations:[{document_id:'doc',excerpt:'provides cybersecurity products'}]}}};
}
test('structural migration never counts as fresh research and does not seed prompts with old labels',()=>{
 const data=inputs(),before=JSON.stringify(data),queue=campaign(),records=buildCompanyRecords(data,{now});
 assert.equal(JSON.stringify(data),before);assert.equal(records.companies[0].governance.fields['tags.business'].review_state,'pending');
 assert.equal(queue.companies.length,1);assert(!JSON.stringify(queue.companies).includes('游戏'));assert(!JSON.stringify(queue.companies).includes('私企'));
 assert.equal(campaignProgress(queue,data.reviews,data.cities).fully_reviewed,0);
});
test('archived search findings attach to the company without becoming verified tags',()=>{
 const company={company_id:'a',display_name:'Synthetic',aliases:[]};
 const base={provider:'linkup',record:'artifact.json',company,vocabulary:new Set(['游戏']),sources:[{url:'https://example.com/about',name:'About',content:'Synthetic is privately held'}]};
 const candidate=archiveStructuredField({field:'ownership',value:'私企',entity:'Synthetic Ltd',evidence_status:'supported',source_urls:['https://example.com/about'],reason:'Shareholder disclosure'},base);
 assert.deepEqual(candidate.issues,[]);
 const wrong=archiveStructuredField({field:'ownership',value:'国企',entity:'Another Company',evidence_status:'supported',source_urls:['https://example.com/about']},base);
 assert(wrong.issues.includes('entity_requires_review'));
 assert.equal(archiveStructuredField({field:'ownership',value:null,evidence_status:'unresolved'},base),null);
 const proposals=summarizeCandidates({'tags.ownership':[candidate,wrong]});
 const data=inputs();data.research={companies:[{company_id:'a',review_state:'requires_independent_review',proposals,fields:{'tags.ownership':[candidate,wrong]}}]};
 const row=buildCompanyRecords(data,{now}).companies[0];
 assert.equal(row.research_candidates.proposals['tags.ownership'].value,'私企');
 assert.equal(row.governance.fields['tags.ownership'].review_state,'pending');
});
test('qualified API fields become runtime tags while retaining unverified provenance and reviewed precedence',()=>{
 const data=inputs(),evidence=[{url:'https://example.com/about',title:'About Synthetic',note:'Synthetic provides cybersecurity services',checked_at:now,provider:'linkup'}];
 data.business.companies[0].business_tags=['网络安全'];
 const decision=(value)=>({status:'api_supported',value,entity:'Synthetic Ltd',checked_at:now,reason:'API source says so',provider:'linkup',source_record:'artifact.json',evidence});
 data.apiLabels={companies:[{company_id:'a',decisions:{'tags.industry':decision(['industrial']),'tags.business':decision(['网络安全']),'tags.ownership':decision('外企'),'descriptions.business_summary':decision('提供网络安全服务')}}]};
 let row=buildCompanyRecords(data,{now}).companies[0],runtime=projectCompanyRecords({companies:[row]},data);
 assert.deepEqual(row.tags.business,['网络安全']);assert.equal(row.governance.fields['tags.ownership'].status,'api_supported');
 assert.equal(row.governance.fields['tags.ownership'].review_state,'api_supported_unverified');
 assert.deepEqual(row.governance.fields['tags.ownership'].providers,['linkup']);
 assert.equal(row.tags.organization_size,'待核实');
 assert.deepEqual(runtime.registry.companies[0].industry_tags,['industrial']);
 assert.deepEqual(runtime.business.companies[0].business_tags,['网络安全']);
 assert.equal(runtime.ownership.companies[0].status,'api_supported');
 assert.equal(runtime.ownership.companies[0].origin,'api_search');
 assert.equal(ownershipDisplayTag(runtime.ownership.companies[0]),'外企');
 assert.equal(runtime.profiles.companies[0].business.status,'api_supported');
 data.reviews={companies:[review()]};row=buildCompanyRecords(data,{now}).companies[0];
 assert.deepEqual(row.tags.business,['网络安全']);assert.equal(row.governance.fields['tags.business'].status,'verified');
 assert.equal(row.descriptions.business_summary,'提供网络安全产品');
 assert(validApiValue('tags.business',['网络安全'],new Set(['网络安全'])));
 assert(!validApiValue('tags.business',['未知新词'],new Set(['网络安全'])));
});
test('demo fields are formal runtime values, keep their unreviewed state, and never replace verified review',()=>{
 const data=inputs(),decision=value=>({status:'demo_unreviewed',value,entity:'Synthetic Ltd',checked_at:now,reason:'Archived search candidate',demo_batch:'demo',evidence:[]});
 data.business.companies[0].business_tags=['网络安全'];
 data.demoLabels={companies:[{company_id:'a',decisions:{'tags.business':decision(['网络安全']),'tags.ownership':decision('外企'),'tags.listing_status':decision('待核实'),'descriptions.business_summary':decision('提供网络安全服务'),'descriptions.customers':decision('未公开披露明确客户信息')}}]};
 let built=buildCompanyRecords(data,{now}),row=built.companies[0];
 assert.deepEqual(row.tags.business,['网络安全']);assert.equal(row.tags.ownership,'外企');assert.equal(row.tags.listing_status,'待核实');
 assert.equal(row.governance.fields['tags.ownership'].status,'demo_unreviewed');assert.equal(row.governance.fields['tags.ownership'].origin,'demo_search');
 const projected=projectCompanyRecords(built,data);
 assert.equal(projected.ownership.companies[0].status,'demo_unreviewed');assert.equal(projected.profiles.companies[0].business.status,'demo_unreviewed');
 data.reviews={companies:[review()]};data.demoLabels.companies[0].decisions['tags.business']=decision(['游戏']);
 row=buildCompanyRecords(data,{now}).companies[0];assert.deepEqual(row.tags.business,['网络安全']);assert.equal(row.governance.fields['tags.business'].status,'verified');
});
test('API publication rejects a conflicting field but still publishes an independent field for the same company',async()=>{
 const dir=path.join(PACK_ROOT,'job-search/artifacts/api-publish-test-'+randomUUID());await fs.mkdir(dir,{recursive:true});
 try {
  const data=inputs(),relative=file=>'job-search/artifacts/'+path.basename(dir)+'/'+file;data.business.companies[0].business_tags.push('网络安全');
  const raw=(ownership)=>({company_id:'a',provider:'linkup',structured_output:{fields:[{field:'ownership',value:ownership,evidence_status:'supported'},{field:'business',value:'网络安全',evidence_status:'supported'}]},sources:[{url:'https://example.com/about',name:'About Synthetic',content:'Synthetic Ltd provides cybersecurity services and is privately held.'}]});
  await fs.writeFile(path.join(dir,'one.json'),JSON.stringify(raw('私企')));await fs.writeFile(path.join(dir,'two.json'),JSON.stringify(raw('外企')));
  const item=(key,value,file)=>({key,value,entity:'Synthetic Ltd',reason:'API result',checked_at:now,source_urls:['https://example.com/about'],provider:'linkup',source_record:relative(file),issues:[]});
  const archive={companies:[{company_id:'a',fields:{'tags.ownership':[item('tags.ownership','私企','one.json'),item('tags.ownership','外企','two.json')],'tags.business':[item('tags.business',['网络安全'],'one.json')]}}]};
  const {labels,audit}=await buildApiPublication(data,{archive});
  assert.equal(labels.companies[0].decisions['tags.ownership'],undefined);
  assert.deepEqual(labels.companies[0].decisions['tags.business'].value,['网络安全']);
  assert.equal(audit.fields['tags.ownership'].conflict,1);
  assert.equal(audit.fields['tags.business'].published,1);
  await fs.writeFile(path.join(dir,'recheck.json'),JSON.stringify(raw('国企')));
  const rechecked={companies:[{company_id:'a',fields:{'tags.ownership':[{...item('tags.ownership','国企','recheck.json'),recheck:true}]}}]};
  const resolved=await buildApiPublication(data,{archive,rechecks:rechecked});
  assert.equal(resolved.labels.companies[0].decisions['tags.ownership'].value,'国企');
  assert.equal(resolved.audit.fields['tags.ownership'].conflict,0);
  const invalidSource={companies:[{company_id:'a',fields:{'tags.ownership':[{...item('tags.ownership','国企','recheck.json'),source_urls:['https://unrelated.example.com/about'],recheck:true}]}}]};
  const stillConflicted=await buildApiPublication(data,{archive,rechecks:invalidSource});
  assert.equal(stillConflicted.audit.fields['tags.ownership'].conflict,1);
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('fresh review refuses stale bodies, search snippets, unsupported terms, foreign IDs and fabricated excerpts',()=>{
 assert(validateReview(review(),campaign(),{now}));
 for(const mutate of [r=>r.company_id='b',r=>r.documents[0].fetched_at='2026-09-22',r=>r.documents[0].read_kind='search_snippet',r=>r.documents[0].content+='edited',r=>r.decisions['tags.business'].value=['新标签'],r=>r.decisions['tags.business'].citations[0].excerpt='nonexistent',r=>r.searches=[],r=>r.decisions['tags.business'].status='unknown']) {
  const row=review();mutate(row);assert.throws(()=>validateReview(row,campaign(),{now}));
 }
});
test('reviewed business is shared by matcher and report, unrelated attributes survive and size dependencies are recomputed',()=>{
 const data=inputs();data.reviews={companies:[review()]};
 const records=buildCompanyRecords(data,{now}),projected=projectCompanyRecords(records,data),row=records.companies[0];
 assert.deepEqual(projected.business.companies[0].business_tags,['网络安全']);
 assert.equal(projected.profiles.companies[0].business.value,'提供网络安全产品');
 assert.equal(projected.ownership.companies[0].ownership_tag,'私企');
 assert.equal(row.tags.organization_size,'大厂');assert.equal(projected.size.companies[0].label,'大厂');
 assert.deepEqual(row.tags.recruitment.campus.cities,['北京']);assert.equal(row.governance.recruitment.campus.city_coverage_complete,false);
 const snapshot=structuredClone(records);data.reviews.companies[0].decisions['tags.business'].value=['游戏'];
 assert.deepEqual(snapshot.companies[0].tags.business,['网络安全']);
});
test('unresolved research is distinct from untouched fields and never fabricates a positive label',()=>{
 const data=inputs(),r=review();r.decisions['tags.ownership']={value:null,status:'unresolved',reason:'没有取得控制关系证据',entity:'Synthetic',checked_at:now,citations:[]};
 assert(validateReview(r,campaign(),{now}));data.reviews={companies:[r]};
 const records=buildCompanyRecords(data,{now}),projected=projectCompanyRecords(records,data),progress=campaignProgress(campaign(),data.reviews,data.cities);
 assert.equal(projected.ownership.companies[0].ownership_tag,'待核实');assert.equal(projected.ownership.companies[0].status,'verified_unresolved');
 assert.equal(progress.searched,1);assert.equal(progress.static_complete,0);assert.equal(progress.fully_reviewed,0);assert.equal(progress.companies[0].reviewed_fields,3);
});
test('unresolved placeholders cannot count as completed static research',()=>{
 const r=review();for(const key of STATIC_FIELDS)r.decisions[key]??={value:null,status:'unresolved',reason:'检索后未取得可靠资料',entity:'Synthetic',checked_at:now,citations:[]};
 assert(validateReview(r,campaign(),{now}));const reviews={companies:[r]};
 assert.equal(campaignProgress(campaign(),reviews).static_complete,0);assert.equal(campaignProgress(campaign(),reviews).fully_reviewed,0);
 const cities=Object.fromEntries(['campus','internship','social'].map(mode=>[mode,{companies:[{company_id:'a',last_refresh_at:now,last_refresh_status:'partial'}]}]));
 assert.equal(campaignProgress(campaign(),reviews,cities).fully_reviewed,0);
});
