#!/usr/bin/env node
import {configureJobSearch} from '../../../scripts/runtime.mjs';
configureJobSearch('campus');
import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson,workspacePath,SKILL_ROOT} from './lib/io.mjs';
import {reviewRecruitment,restoreRequestRecruitmentEvidence,verificationIssues,RECRUITMENT_POLICY_VERSION} from './lib/recruitment-policy.mjs';
import {normalizeJobLocations,jobCityStatus} from './lib/locations.mjs';
import {jobFingerprint} from './lib/job-version.mjs';

const flags={};for(let i=2;i<process.argv.length;i+=2)flags[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
const source=workspacePath(path.resolve(flags.source||''));
const work=workspacePath(path.resolve(flags.work||'artifacts/pending-review-20260912'));
const sourceRun=await readJson(path.join(source,'run.json'));
const key=j=>JSON.stringify([j.company_id,String(j.job_id)]);
const pendingStates=new Set(['needs_verification','missing_body']);
let bodyModule;try{bodyModule=await import('./lib/body-review.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
let manual=new Map();
for(const dir of [path.join(work,'semantic'),path.join(work,'body')]){
  const files=await fs.readdir(dir).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e));
  for(const file of files.filter(f=>f.endsWith('-overrides.json')||f==='overrides.json')){
    const payload=await readJson(path.join(dir,file));
    for(const entry of payload.items||[]){
      const item={...entry};
      if(item.formal_status!==undefined){item.recruitment_reason=item.reason;item.recruitment_review_evidence=item.evidence||item.source_files||[];}
      if(item.body_complete!==undefined){item.body_reason=item.body_reason||item.reason;item.body_source_files=item.source_files;}
      if(item.cities!==undefined){item.location_reason=item.location_reason||item.reason;item.location_evidence=item.location_evidence||item.evidence||[];}
      const k=key(item),existing=manual.get(k)||{};
      for(const field of ['formal_status','body_complete','description','requirements','cities'])if(existing[field]!==undefined&&item[field]!==undefined&&JSON.stringify(existing[field])!==JSON.stringify(item[field]))throw Error('Conflicting manual review: '+k+' / '+field);
      manual.set(k,{...existing,...item,review_files:[...(existing.review_files||[]),path.join(dir,file)]});
    }
  }
}
const results=[],reviewed=[],remaining=[],changes=[],used=new Set();
for(const company of sourceRun.companies.filter(c=>c.selected)){
  const original=await readJson(path.join(source,'companies',company.company_id+'.json'),null);if(!original)continue;
  const data=structuredClone(original);
  data.counts={total:data.jobs.length,nonformal:0,not_open:0,other_city:0,needs_verification:0,incomplete_body:0,to_assess:0};
  data.jobs=data.jobs.map(old=>{
    let job=reviewRecruitment(restoreRequestRecruitmentEvidence(structuredClone(old),original.requests||[]));
    if(!job.body_complete&&bodyModule&&!['manual_full_record_review','model_full_available_body_and_local_evidence_review'].includes(job.body_review?.method))job=bodyModule.reviewJobBody(job);
    const override=manual.get(key(old));
    if(override){
      if(!pendingStates.has(old.evaluation_status))throw Error('Manual override outside original pending scope: '+key(old));
      if(override.jd_fingerprint&&override.jd_fingerprint!==old.jd_fingerprint)throw Error('Stale manual review: '+key(old));
      used.add(key(old));
      if(override.formal_status!==undefined){
        if(!['formal','social','internship','activity','parttime','unknown'].includes(override.formal_status))throw Error('Invalid manual type: '+key(old));
        job.formal_status=override.formal_status;
        job.recruitment_evidence={...job.recruitment_evidence,admission_review:{policy_version:RECRUITMENT_POLICY_VERSION,status:override.formal_status,reason:override.recruitment_reason,evidence:override.recruitment_review_evidence,method:'manual_full_record_review',review_files:override.review_files}};
      }
      if(override.body_complete!==undefined){
        for(const field of ['body_complete','description','requirements'])if(override[field]!==undefined)job[field]=override[field];
        job.body_review={...job.body_review,...override.body_review,method:override.body_review?.method||'manual_full_record_review',reason:override.body_reason,source_files:override.body_source_files,review_files:override.review_files};
      }
    }
    const loc=normalizeJobLocations(job);
    job.location_structured_evidence=loc.structured_evidence||[];
    Object.assign(job,{cities:loc.cities,location_special:loc.special,location_unknown:loc.unknown,location_unresolved:loc.unresolved,location_code_evidence:loc.code_evidence,location_description_evidence:loc.description_evidence,location_title_evidence:loc.title_evidence||[],locations_raw:loc.raw});
    if(override?.cities){job.cities=[...new Set([...job.cities,...override.cities])];job.location_unknown=false;job.location_review={reason:override.location_reason||override.reason,evidence:override.location_evidence||override.evidence||[],review_files:override.review_files};}
    job.city_status=jobCityStatus(job,sourceRun.profile.city_filters||[]);
    if(['internship','social','activity','parttime'].includes(job.formal_status)){job.evaluation_status='excluded_nonformal';data.counts.nonformal++;}
    else if(job.open_status==='closed'){job.evaluation_status='excluded_closed';data.counts.not_open++;}
    else if(job.city_status==='excluded'){job.evaluation_status='excluded_city';data.counts.other_city++;}
    else if(job.formal_status!=='formal'||job.open_status!=='open'||job.city_status==='unknown'){job.evaluation_status='needs_verification';data.counts.needs_verification++;}
    else if(!job.body_complete){job.evaluation_status='missing_body';data.counts.incomplete_body++;}
    else{job.evaluation_status='to_assess';data.counts.to_assess++;}
    job.verification_issues=pendingStates.has(job.evaluation_status)?verificationIssues(job):[];
    job.jd_fingerprint=jobFingerprint(job);
    if(pendingStates.has(old.evaluation_status)){
      const row={company_id:job.company_id,company_name:job.company_name,job_id:job.job_id,title:job.title,official_url:job.official_url,before:{status:old.evaluation_status,formal_status:old.formal_status,cities:old.cities,body_complete:old.body_complete,jd_fingerprint:old.jd_fingerprint},after:{status:job.evaluation_status,formal_status:job.formal_status,cities:job.cities,body_complete:job.body_complete,jd_fingerprint:job.jd_fingerprint},recruitment_review:job.recruitment_evidence?.admission_review,title_city_evidence:job.location_title_evidence,location_review:job.location_review,body_review:job.body_review,remaining_issues:job.verification_issues,raw_file:old.raw_file};
      row.location_code_evidence=job.location_code_evidence;
      row.location_structured_evidence=job.location_structured_evidence;
      row.location_description_evidence=job.location_description_evidence;
      reviewed.push(row);
      if(pendingStates.has(job.evaluation_status))remaining.push({company,job,original_job:old});
    }
    if(old.evaluation_status!==job.evaluation_status)changes.push({company:job.company_name,job_id:job.job_id,title:job.title,from:old.evaluation_status,to:job.evaluation_status});
    return job;
  });
  // Keep original collection coverage and timestamps; this is a snapshot re-review, not a new fetch.
  data.verification_reviewed_at=new Date().toISOString();
  results.push(data);
}
for(const k of manual.keys())if(!used.has(k))throw Error('Unknown manual override job: '+k);
const counts={};for(const row of reviewed)counts[row.after.status]=(counts[row.after.status]||0)+1;
const reasons={};for(const row of reviewed)for(const issue of row.remaining_issues)reasons[issue.code]=(reasons[issue.code]||0)+1;
const allCounts={};for(const c of results)for(const j of c.jobs)allCounts[j.evaluation_status]=(allCounts[j.evaluation_status]||0)+1;
const audit={generated_at:new Date().toISOString(),source_run:source,policy_version:RECRUITMENT_POLICY_VERSION,reviewed_count:reviewed.length,results:counts,remaining_issue_counts:reasons,total_run_counts:allCounts,manual_review_count:manual.size,source_failures:results.filter(c=>c.coverage.status==='failed').map(c=>c.display_name),ownership_unresolved:sourceRun.companies.filter(c=>c.ownership_tag==='待核实').map(c=>({company:c.display_name,reason:c.ownership_reason,evidence:c.ownership_evidence})),items:reviewed};
await writeJson(path.join(work,'draft-audit.json'),audit);
await writeJson(path.join(work,'remaining-jobs.json'),{items:remaining});
for(const c of results)await writeJson(path.join(work,'draft-companies',c.company_id+'.json'),c);
if(flags.out){
  const out=workspacePath(path.resolve(flags.out));if(out===source)throw Error('Cannot overwrite source run');
  if(await readJson(path.join(out,'run.json'),null))throw Error('Output run already exists; use a new directory');
  const run={...sourceRun,created_at:new Date().toISOString(),status:'verification_reviewed',source_run:source,report_note:`按用户确认的新校招和标题城市规则复核上一轮全部 ${reviewed.length} 个资料待核实岗位。复用原 API 快照，采集时间及来源限制保持原记录。资料核验与个人匹配评估分开，尚未完成的能力与意愿评估继续标待评估。`,verification_review:{reviewed_count:reviewed.length,results:counts,remaining_issue_counts:reasons}};
  await writeJson(path.join(out,'run.json'),run);await fs.mkdir(path.join(out,'assessments'),{recursive:true});
  for(const c of results){
    await writeJson(path.join(out,'companies',c.company_id+'.json'),c);
    const previousAssessments=await readJson(path.join(source,'assessments',c.company_id+'.json'),null);
    if(previousAssessments)await writeJson(path.join(out,'assessments',c.company_id+'.json'),previousAssessments);
  }
  await writeJson(path.join(out,'verification-review.json'),audit);
}
console.log(JSON.stringify({reviewed:audit.reviewed_count,results:counts,remaining_issue_counts:reasons,total_run_counts:allCounts,manual_review_count:manual.size,remaining_file:path.join(work,'remaining-jobs.json'),output:flags.out||null}));
