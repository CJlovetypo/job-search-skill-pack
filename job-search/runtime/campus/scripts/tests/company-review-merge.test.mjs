import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mergePublishedReview,buildCompanyRecords,campaignProgress,contentHash,validateReview} from '../../../../../shared/job-search-core/scripts/lib/company-records.mjs';

const oldTime='2026-09-01T01:00:00Z',newTime='2026-09-25T01:00:00Z';
function review(campaign_id,field,value,time,content='Body '+campaign_id) {
 return {company_id:'a',campaign_id,identity_reason:'Synthetic company matches official site',searches:[{query:'Synthetic '+field,tool:'builtin',searched_at:time,status:'success',result_urls:['https://example.com/about']}],
 documents:[{id:'d0',url:'https://example.com/'+campaign_id,title:campaign_id,entity:'Synthetic',identity_basis:'Synthetic official',content,sha256:contentHash(content),fetched_at:time,tool:'builtin',read_kind:'page_body'}],
 decisions:{[field]:{status:'verified',value,reason:'Exact source',entity:'Synthetic',as_of:time,checked_at:time,citations:[{document_id:'d0',excerpt:content}]}}};
}
function build(r) {return buildCompanyRecords({registry:{companies:[{company_id:'a',display_name:'Synthetic'}]},business:{companies:[]},ownership:{companies:[]},profiles:{companies:[]},size:{companies:[]},reviews:{companies:[r]}},{now:newTime}).companies[0];}

test('partial publication preserves old field value, evidence time, hash and campaign',()=>{
 const prior=review('old','descriptions.workforce','500 employees',oldTime),next=review('new','tags.headquarters_country','中国',newTime);
 const snapshots=[structuredClone(prior),structuredClone(next)],before=build(prior);
 const merged=mergePublishedReview(prior,next),after=build(merged);
 assert.equal(after.descriptions.workforce,'500 employees');
 assert.deepEqual(after.governance.fields['descriptions.workforce'],before.governance.fields['descriptions.workforce']);
 assert.equal(after.tags.headquarters_country,'中国');
 assert.equal(after.governance.fields['tags.headquarters_country'].campaign_id,'new');
 assert.deepEqual([prior,next],snapshots);
 assert.equal(merged.documents.length,2);
 const id=merged.decisions['tags.headquarters_country'].citations[0].document_id;
 assert.notEqual(id,'d0');assert.equal(merged.documents.find(d=>d.id===id).content,'Body new');
 assert.deepEqual(mergePublishedReview(merged,next),merged);
});

test('stale overlapping field rejects while independent older fields can be preserved',()=>{
 const latest=review('new','descriptions.workforce','600 employees',newTime);
 assert.throws(()=>mergePublishedReview(latest,review('old','descriptions.workforce','500 employees',oldTime)),/拒绝覆盖/);
 assert.equal(build(mergePublishedReview(latest,review('old','tags.headquarters_country','中国',oldTime))).descriptions.workforce,'600 employees');
 const clash=review('new','descriptions.workforce','700 employees',newTime);
 assert.throws(()=>mergePublishedReview(latest,clash),/同一时间/);
 assert.throws(()=>mergePublishedReview(latest,{...clash,company_id:'b'}),/不同主体/);
});

test('intentional unresolved correction affects only that field; old evidence remains archived',()=>{
 const old=review('old','descriptions.workforce','500 employees',oldTime);
 old.decisions['tags.headquarters_country']={...old.decisions['descriptions.workforce'],value:'中国'};
 const next=review('new','descriptions.workforce',null,newTime);next.documents=[];
 next.decisions['descriptions.workforce']={status:'unresolved',value:null,entity:'Synthetic',reason:'Sources conflict',checked_at:newTime,citations:[]};
 const merged=mergePublishedReview(old,next),row=build(merged);
 assert.equal(row.descriptions.workforce,null);assert.equal(row.tags.headquarters_country,'中国');
 assert.equal(row.governance.fields['tags.headquarters_country'].campaign_id,'old');
 assert.equal(merged.documents[0].content,'Body old');
 assert.equal(merged.searches.length,2);
 const campaign={campaign_id:'new',started_at:'2026-09-25T00:00:00Z',companies:[{company_id:'a'}],vocabulary:[]};
 assert.equal(campaignProgress(campaign,{companies:[merged]}).companies[0].reviewed_fields,1);
 assert.equal(campaignProgress(campaign,{companies:[merged]}).static_complete,0);
 assert(validateReview(next,campaign,{now:newTime}));
 next.decisions['descriptions.workforce'].campaign_id='old';
 assert.throws(()=>validateReview(next,campaign,{now:newTime}),/批次不一致/);
});
