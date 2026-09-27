import fs from 'node:fs/promises';
import path from 'node:path';
import {CORE_ROOT,PACK_ROOT,MODE_ROOTS} from '../../runtime-context.mjs';
import {RESEARCH_ROOT,REVIEWS_FILE,API_LABELS_FILE,DEMO_LABELS_FILE,INTERNAL_RECORDS_FILE} from '../../maintenance-paths.mjs';
import {loadCompanyInputs,buildCompanyRecords,projectCompanyRecords,indexById,mergePublishedReview,validateReview,deriveOrganizationSize} from './company-records.mjs';
import {publicCompanyRecords,publicCompatibility} from './public-company-data.mjs';
import {REVIEW_POLICY_VERSION,reviewHash,scoreAssessment} from './company-review-policy.mjs';
import {bytesHash,verifyReviewEvidence} from './company-evidence.mjs';
import {commitPublication,withPublicationLock,committedPublication} from './company-publication-transaction.mjs';
import {evaluateCalibration,verifyCalibrationSources} from './company-review-calibration.mjs';

const names={business:'company-business-tags',ownership:'company-ownership-tags',profiles:'company-profiles',size:'company-size-tags'};
const publicFile=name=>path.join(CORE_ROOT,'data',name+'.json');
const encode=x=>JSON.stringify(x)+'\n';
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const get=(o,k)=>k.split('.').reduce((v,k)=>v?.[k],o);
const set=(o,k,v)=>{const [a,b]=k.split('.');o[a][b]=structuredClone(v);};
export const companyPublicationTargets=()=>[REVIEWS_FILE,API_LABELS_FILE,DEMO_LABELS_FILE,INTERNAL_RECORDS_FILE,publicFile('company-records'),...Object.values(names).map(publicFile)];
export async function companyInputHashes() {
  const files=[...companyPublicationTargets(),publicFile('business-taxonomy'),path.join(CORE_ROOT,'assets/sources.json'),...Object.values(names).map(n=>path.join(RESEARCH_ROOT,'inputs',n+'.json')),
    ...Object.values(MODE_ROOTS).map(p=>path.join(PACK_ROOT,p,'company-city-index.json'))];
  return Object.fromEntries(await Promise.all(files.map(async f=>[f,bytesHash(await fs.readFile(f))])));
}

// Preserve all domains except approved fields and the existing size dependency.
export function patchReviewedFields(current,generated,selections) {
  const next=structuredClone(current),byId=indexById(next),computed=indexById(generated),changes=[];
  next.generated_at=generated.generated_at;
  for(const selection of selections) {
    const row=byId.get(selection.company_id),candidate=computed.get(selection.company_id);
    if(!row||!candidate)throw Error('Publication company missing');
    const fields=new Set(selection.fields);
    if(fields.has('tags.ownership')||fields.has('descriptions.workforce'))fields.add('tags.organization_size');
    for(const field of fields) {
      const before={value:get(row,field),metadata:row.governance.fields[field]};
      if(field==='tags.organization_size')deriveOrganizationSize(row,{now:generated.generated_at,sizeEligible:selection.size_eligible!==false});
      else {set(row,field,get(candidate,field));row.governance.fields[field]=structuredClone(candidate.governance.fields[field]);}
      const after={value:get(row,field),metadata:row.governance.fields[field]};
      if(reviewHash(before)!==reviewHash(after))changes.push({company_id:row.company_id,field,before,after});
    }
  }
  return {records:next,changes};
}

export function validateApprovalManifest(approval,campaign,reviews,{now=new Date().toISOString()}={}) {
  if(approval.schema_version!==2||approval.policy_version!==REVIEW_POLICY_VERSION||approval.campaign_hash!==reviewHash(campaign))throw Error('Approval policy/campaign changed');
  if(!approval.reviewer||!Array.isArray(approval.fields)||!approval.fields.length)throw Error('An explicit field approval manifest is required');
  if(!['pilot','calibrated'].includes(approval.mode))throw Error('Publication mode must be pilot or calibrated');
  const map=indexById({companies:reviews}),seen=new Set(),accepted=[];
  for(const item of approval.fields) {
    const key=item.company_id+'|'+item.field;if(seen.has(key))throw Error('Duplicate approved field');seen.add(key);
    const review=map.get(item.company_id),decision=review?.decisions?.[item.field];
    if(!review||reviewHash(review)!==item.review_hash||!decision||decision.status!=='verified')throw Error('Approved review changed or is not a verified candidate: '+key);
    if(!Number.isFinite(Date.parse(item.assessment?.reviewed_at))||Date.parse(item.assessment.reviewed_at)>Date.parse(now)+60000||Date.parse(item.assessment.reviewed_at)<Date.parse(review.reviewed_at))throw Error('Invalid approval time');
    const evidenceIds=[...new Set(decision.citations.map(c=>c.document_id))];
    const result=scoreAssessment(item.field,item.assessment,{decision,documentIds:evidenceIds});
    if(!result.eligible)throw Error('Field fails review gate: '+key+' '+result.errors.join(','));
    accepted.push({...item,score:result.total,risk:result.risk});
  }
  if(approval.mode==='pilot'&&new Set(accepted.map(x=>x.company_id)).size>50)throw Error('Pilot publication is limited to 50 companies');
  if(approval.mode==='calibrated'&&(!approval.calibration_file||!approval.calibration_sha256))throw Error('Calibrated publication needs an independently checked calibration artifact');
  return accepted;
}

export async function prepareReviewPublication(work,{now=new Date().toISOString(),trial=false}={}) {
  const hashes=await companyInputHashes();
  const files=[path.join(work,'campaign.json'),path.join(work,'approval.json'),...(await fs.readdir(path.join(work,'reviews'))).filter(n=>n.endsWith('.json')).sort().map(n=>path.join(work,'reviews',n))];
  for(const f of files)hashes[f]=bytesHash(await fs.readFile(f));
  const campaign=await read(files[0]),approval=await read(files[1]),reviews=await Promise.all(files.slice(2).map(read));
  if(campaign.schema_version!==2||campaign.evidence_policy!=='archived_body')throw Error('Legacy batches must be reviewed under the evidence policy before publication');
  for(const r of reviews)validateReview(r,campaign,{now});
  const accepted=validateApprovalManifest(approval,campaign,reviews,{now});
  let calibration=null;
  if(approval.calibration_file&&approval.calibration_sha256) {
    const file=path.resolve(approval.calibration_file),bytes=await fs.readFile(file);hashes[file]=bytesHash(bytes);
    if(hashes[file]!==approval.calibration_sha256)throw Error('Calibration artifact changed');
    const dataset=JSON.parse(bytes);calibration=evaluateCalibration(dataset);
    Object.assign(hashes,await verifyCalibrationSources(dataset));
    if(!trial&&calibration.status!=='passed')throw Error('Calibration has not passed: '+calibration.reasons.join(','));
  }
  if(!trial&&calibration?.status!=='passed')throw Error('Complete calibration before pilot or calibrated publication; use --trial true for a read-only preview');
  const inputs=await loadCompanyInputs({includeResearch:false}),previous=indexById(inputs.reviews),selected=[],proofs=[],selections=[];
  const current=await read(publicFile('company-records')),internal=await read(INTERNAL_RECORDS_FILE),currentMap=indexById(current);
  for(const r of reviews) {
    const approvals=accepted.filter(a=>a.company_id===r.company_id);if(!approvals.length)continue;
    const fields=approvals.map(a=>a.field),review=structuredClone(r);review.decisions=Object.fromEntries(fields.map(f=>[f,review.decisions[f]]));
    const docs=new Set(Object.values(review.decisions).flatMap(d=>d.citations.map(c=>c.document_id)));review.documents=review.documents.filter(d=>docs.has(d.id));
    const evidence=await verifyReviewEvidence(review);proofs.push(...evidence);for(const p of evidence)hashes[p.file]=p.sha256;
    for(const f of fields) {
      const currentMeta=currentMap.get(r.company_id)?.governance.fields[f];if(!currentMeta)throw Error('Unknown formal company or field');
      if(currentMeta.checked_at&&Date.parse(currentMeta.checked_at)>Date.parse(review.decisions[f].checked_at))throw Error('Formal field has a newer decision: '+r.company_id+' '+f);
    }
    review.field_assessments=Object.fromEntries(approvals.map(a=>[a.field,a.assessment]));
    previous.set(r.company_id,mergePublishedReview(previous.get(r.company_id),review));selected.push(review);
    selections.push({company_id:r.company_id,fields,size_eligible:previous.get(r.company_id)?.field_assessments?.['descriptions.workforce']?.size_eligible});
  }
  const nextReviews={schema_version:2,updated_at:now,companies:[...previous.values()]};
  const generated=buildCompanyRecords({...inputs,reviews:nextReviews},{now});
  const patched=patchReviewedFields(current,publicCompanyRecords(generated),selections),full=patchReviewedFields(internal,generated,selections);
  const compatibility=Object.fromEntries(await Promise.all(Object.entries(names).map(async([k,n])=>[k,await read(publicFile(n))])));
  const projected=projectCompanyRecords(patched.records,{...inputs,...compatibility});
  const writes=[{file:REVIEWS_FILE,bytes:encode(nextReviews)},{file:INTERNAL_RECORDS_FILE,bytes:encode(full.records)}];
  for(const [kind,name]of Object.entries(names)) {
    const affected=new Set(selections.filter(s=>s.fields.some(f=>kind==='business'?['tags.business','descriptions.business_summary'].includes(f):kind==='ownership'?f==='tags.ownership':kind==='profiles'?['descriptions.business_summary','descriptions.workforce','descriptions.capital'].includes(f):['tags.ownership','descriptions.workforce'].includes(f))).map(s=>s.company_id));
    const replacement=indexById(publicCompatibility(kind,projected[kind]));
    const next={...compatibility[kind],companies:compatibility[kind].companies.map(r=>affected.has(r.company_id)?replacement.get(r.company_id):r)};
    writes.push({file:publicFile(name),bytes:encode(next)});
  }
  writes.push({file:publicFile('company-records'),bytes:encode(publicCompanyRecords(patched.records))});
  for(const [file,hash]of Object.entries(hashes))if(bytesHash(await fs.readFile(file))!==hash)throw Error('Inputs changed during preflight: '+file);
  const summary={schema_version:2,policy_version:REVIEW_POLICY_VERSION,campaign_id:campaign.campaign_id,prepared_at:now,mode:approval.mode,publishable:!trial&&calibration?.status==='passed',calibration_status:calibration?.status||'not_calibrated',
    companies:selected.length,fields:accepted.length,changes:patched.changes,inputs:hashes,outputs:writes.map(w=>({file:w.file,sha256:bytesHash(w.bytes)})),approved:accepted.map(a=>({company_id:a.company_id,field:a.field,score:a.score,risk:a.risk})),evidence_files:[...new Set(proofs.map(p=>p.file))]};
  summary.plan_hash=reviewHash(summary);
  return {summary,writes};
}

export async function publishReviewedWork(work) {
  return withPublicationLock(async()=>{
    const preview=await read(path.join(work,'preflight.json'));
    const {plan_hash,...payload}=preview;
    if(reviewHash(payload)!==plan_hash)throw Error('Preflight hash mismatch');
    if(preview.publishable!==true)throw Error('Trial preview cannot be published; complete calibration and regenerate preflight');
    const existing=await committedPublication(preview.plan_hash);
    if(existing) {
      const receipt={...existing,campaign_id:preview.campaign_id,companies:preview.companies,published_fields:preview.fields,plan_hash:preview.plan_hash};
      await fs.writeFile(path.join(work,'publication.json'),JSON.stringify(receipt,null,2)+'\n');return receipt;
    }
    const plan=await prepareReviewPublication(work,{now:preview.prepared_at});
    if(plan.summary.plan_hash!==preview.plan_hash)throw Error('Preflight changed; regenerate and inspect the new preview');
    const result=await commitPublication(plan.writes,{inputs:plan.summary.inputs,metadata:{kind:'independent_review',work,campaign_id:plan.summary.campaign_id,plan_hash:plan.summary.plan_hash,fields:plan.summary.approved}});
    const receipt={...result,campaign_id:plan.summary.campaign_id,companies:plan.summary.companies,published_fields:plan.summary.fields,published_at:new Date().toISOString(),plan_hash:plan.summary.plan_hash};
    await fs.writeFile(path.join(work,'publication.json'),JSON.stringify(receipt,null,2)+'\n');return receipt;
  });
}
