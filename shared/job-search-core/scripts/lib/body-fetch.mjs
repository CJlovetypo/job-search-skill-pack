import path from 'node:path';

const text=j=>[j.description,j.requirements].some(x=>typeof x==='string'&&/[\p{L}\p{N}]/u.test(x));
const file=f=>f?path.resolve(f).replaceAll('\\','/').toLowerCase():null;
/** Acquisition facts only; an old body_complete flag is never acquisition proof. */
export function bodyFetch(job,requests=[]) {
  const error=String(job.detail_error||job.raw_metadata?.detail_fetch_error||'');
  const skip=String(job.detail_skipped_reason||'');
  const refs=new Set([job.raw_file,...job.evidence_files||[]].map(file).filter(Boolean));
  const related=requests.filter(r=>[r.response_file,r.decoded_response_file].some(f=>f&&refs.has(file(f))));
  const detail=related.filter(r=>/detail/i.test(r.purpose||''));
  const list=related.filter(r=>/list|search/i.test(r.purpose||''));
  const origin=detail.length?'detail':list.length?'list':job.body_fetch?.origin||'unknown';
  const result=(status,reason)=>({status,origin,reason});
  if(/mismatch|differs|identity|tenant/i.test(error))return result('failed','detail_identity_mismatch');
  if(/summary|truncat/i.test(skip)||job.body_is_summary===true)return result('partial','summary_or_truncated_body');
  // A list may already carry the full body even when a redundant detail was skipped.
  if(text(job)&&detail.some(r=>r.http_status>=200&&r.http_status<300&&r.response_is_json!==false))return result('available','successful_bound_detail_body');
  if(text(job)&&list.some(r=>r.http_status>=200&&r.http_status<300&&r.response_is_json!==false&&/full.*bod/i.test(r.purpose||'')))return result('available','successful_bound_full_body_list');
  if(error&&!/limit|budget|skipped/i.test(error))return result('failed','detail_fetch_failed');
  if(related.some(r=>r.http_status>=400))return result('failed','body_response_failed');
  if(job.body_fetch?.status==='available'&&text(job))return {...job.body_fetch,origin};
  if(skip||/limit|budget|skipped/i.test(error))return result('not_attempted',skip||'detail_budget_exhausted');
  if(job.body_fetch&&['partial','failed','not_attempted'].includes(job.body_fetch.status))return {...job.body_fetch,origin};
  if(detail.length&&!text(job))return result('partial','detail_body_empty');
  return result('unknown',text(job)?'body_provenance_unconfirmed':'body_not_observed');
}

export function needsBodyFetch(job) {
  if(job.body_complete===true)return false;
  return job.body_fetch?.status!=='available'&&job.detail_skipped_reason!=='public_list_capability_only';
}

export function bodyCacheReusable(result) {
  const c=result.coverage||{};
  const complete=c.status==='complete'||c.collection_complete===true||c.list_complete===true||c.contexts?.length&&c.contexts.every(x=>x.list_complete===true);
  return Boolean(complete)&&!(result.jobs||[]).some(j=>needsBodyFetch(j)&&!['excluded','unknown'].includes(j.city_status)&&j.open_status!=='closed'&&j.detail_skipped_reason!=='explicit_non_target_city');
}

export function bodyPendingReason(job) {
  const f=job.body_fetch;
  if(f?.status==='available') {
    const s=job.body_review?.sections||{};
    return [s.responsibilities!=='identified'?'岗位职责未识别':'',s.requirements!=='identified'?'任职条件未识别':''].filter(Boolean).join('；')||'正文待复核';
  }
  if(f?.status==='failed')return '正文获取失败：'+f.reason;
  if(f?.status==='partial')return '仅取得部分正文：'+f.reason;
  if(f?.status==='not_attempted')return '正文未获取：'+f.reason;
  return '正文获取证据不足，待核验';
}
