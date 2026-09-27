import {FIELD_RULES,REVIEW_POLICY_VERSION,reviewHash,scoreAssessment} from './company-review-policy.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {PACK_ROOT} from '../../runtime-context.mjs';
import {bytesHash,verifyReviewEvidence} from './company-evidence.mjs';

// The evaluation is recomputed from field assessments and separately recorded
// reference reviews. A summary claiming "passed" is never a publication input.
export function evaluateCalibration(dataset) {
  if(dataset?.schema_version!==1||dataset.policy_version!==REVIEW_POLICY_VERSION||!Array.isArray(dataset.samples))throw Error('Invalid calibration dataset');
  const rows=[],seen=new Set(),groups={calibration:new Set(),test:new Set()};
  for(const sample of dataset.samples) {
    const {company_id,field,split,decision,assessment,reference,document_ids}=sample;
    const key=company_id+'|'+field;
    if(!company_id||!FIELD_RULES[field]||!groups[split]||seen.has(key))throw Error('Invalid or duplicated calibration sample');
    seen.add(key);groups[split].add(company_id);
    if(!reference?.reviewer||reference.reviewer===assessment?.reviewer||reference.blinded!==true||
      !Number.isFinite(Date.parse(reference.reviewed_at))||reference.decision_hash!==reviewHash(decision)||
      typeof reference.acceptable!=='boolean'||typeof reference.hard_gate_error!=='boolean'||!reference.reason?.trim()||
      !Array.isArray(document_ids)||!document_ids.length||!reference.document_ids?.length||reference.document_ids.some(id=>!document_ids.includes(id)))throw Error('Missing independent reference review: '+key);
    const score=scoreAssessment(field,assessment,{decision,documentIds:document_ids});
    rows.push({company_id,field,split,accepted:score.eligible,correct:reference.acceptable,hard_gate_error:reference.hard_gate_error,errors:score.errors,score:score.total,reason:reference.reason});
  }
  if([...groups.test].some(id=>groups.calibration.has(id)))throw Error('Calibration and test companies overlap');
  const summarize=rs=>{const accepted=rs.filter(x=>x.accepted),correct=accepted.filter(x=>x.correct),badGates=accepted.filter(x=>x.hard_gate_error);
    const n=accepted.length,p=n?correct.length/n:null,z=1.96;
    const lower=n?(p+z*z/(2*n)-z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/(1+z*z/n):null;
    return {tested:rs.length,accepted:n,correct:correct.length,accepted_precision:p,hard_gate_errors:badGates.length,
      missed_acceptable:rs.filter(x=>!x.accepted&&x.correct).length,wilson_95_lower:lower};};
  const training=rows.filter(x=>x.split==='calibration'),test=rows.filter(x=>x.split==='test');
  const overall=summarize(test),coverage=Object.keys(FIELD_RULES).map(field=>({field,...summarize(test.filter(x=>x.field===field)),calibration_samples:training.filter(x=>x.field===field).length}));
  const reasons=[];
  if(training.length<240)reasons.push('calibration_samples_below_240');
  if(coverage.some(x=>x.calibration_samples<20))reasons.push('calibration_field_coverage_below_20');
  if(coverage.some(x=>x.tested<30))reasons.push('test_field_coverage_below_30');
  if(coverage.some(x=>x.accepted<20))reasons.push('accepted_field_coverage_below_20');
  if(overall.accepted_precision===null||overall.accepted_precision<0.98)reasons.push('precision_below_098');
  if(coverage.some(x=>x.accepted_precision===null||x.accepted_precision<0.98))reasons.push('field_precision_below_098');
  if(overall.hard_gate_errors)reasons.push('accepted_hard_gate_error');
  return {schema_version:1,policy_version:REVIEW_POLICY_VERSION,dataset_hash:reviewHash(dataset),status:reasons.length?'not_passed':'passed',reasons,
    calibration_samples:training.length,held_out_companies:groups.test.size,...overall,field_coverage:coverage,
    errors:rows.filter(x=>x.split==='test'&&(x.accepted&&!x.correct||x.accepted&&x.hard_gate_error||!x.accepted&&x.correct)),
    limitations:['Reference reviews require a genuinely separate, blinded review; a different reviewer name alone does not establish independence.',
      'Observed precision and evidence scores are not guarantees or calibrated probabilities. Confidence intervals show the sampling uncertainty.',
      'The overall Wilson interval treats field rows as independent; repeated fields from the same company may be correlated, so this interval is nominal and not cluster-adjusted.',
      'Results describe this maintenance candidate sample. They do not establish accuracy for unreviewed companies or other source distributions.']};
}

// Publication additionally checks that calibration decisions refer to real
// archived bodies. Calculator fixtures and unbacked reference assertions cannot
// be used as a production calibration artifact.
export async function verifyCalibrationSources(dataset,{root=PACK_ROOT}={}) {
  const files={},cache=new Map(),checked=new Set(),bodySplits=new Map();
  for(const sample of dataset.samples) {
    if(!sample.review_file||!/^[a-f0-9]{64}$/.test(sample.review_sha256||''))throw Error('Calibration sample needs a hashed source review');
    const file=await fs.realpath(path.resolve(root,sample.review_file)),rel=path.relative(root,file);
    if(!rel.startsWith(path.join('shared','job-search-core','state')+path.sep)&&!rel.startsWith('datasets'+path.sep)&&!rel.startsWith(path.join('job-search','artifacts')+path.sep))throw Error('Calibration source outside maintenance archives');
    let review=cache.get(file);
    if(!review){const bytes=await fs.readFile(file);files[file]=bytesHash(bytes);review=JSON.parse(bytes);cache.set(file,review);}
    if(files[file]!==sample.review_sha256||review.company_id!==sample.company_id||reviewHash(review.decisions?.[sample.field])!==reviewHash(sample.decision))throw Error('Calibration source decision changed');
    const documents=(review.documents||[]).filter(d=>sample.document_ids.includes(d.id));
    if(documents.length!==new Set(sample.document_ids).size)throw Error('Calibration source document missing');
    if(['calibration','test'].includes(sample.split))for(const doc of documents) {
      const hash=bytesHash(doc.content),previous=bodySplits.get(hash);
      if(previous&&previous!==sample.split)throw Error('Calibration page body overlaps splits; group related company identities together');
      bodySplits.set(hash,sample.split);
    }
    for(const c of sample.decision.citations||[])if(!documents.some(d=>d.id===c.document_id&&d.content.includes(c.excerpt)))throw Error('Calibration source citation mismatch');
    if(!sample.decision.citations?.length)throw Error('Calibration needs a cited candidate');
    const key=review.company_id+'|'+file+'|'+[...sample.document_ids].sort().join('|');
    if(!checked.has(key))for(const proof of await verifyReviewEvidence({company_id:review.company_id,documents},{root}))files[proof.file]=proof.sha256;
    checked.add(key);
  }
  return files;
}
