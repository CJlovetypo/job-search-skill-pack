import {createHash} from 'node:crypto';
export const RELEVANCE_VERSION=1;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const relevanceTarget=q=>({roles:q.roles||[],exclude_keywords:q.exclude_keywords||[]});
export function relevanceRequest(job,query){
  return {job_key:job.company_id+'|'+job.job_id,job_fingerprint:hash([job.title,job.description||'',job.requirements||'',job.body_complete===true]),target_fingerprint:hash(relevanceTarget(query)),rule_version:RELEVANCE_VERSION,title:job.title,description:job.description||'',requirements:job.requirements||'',body_complete:job.body_complete===true,target:relevanceTarget(query)};
}
export const relevanceKey=r=>hash([r.job_key,r.job_fingerprint,r.target_fingerprint,r.rule_version]);
export function validateRelevance(review,request){
  for(const field of ['job_key','job_fingerprint','target_fingerprint','rule_version'])if(review?.[field]!==request[field])throw Error('相关性判断指纹或规则不一致：'+field);
  if(!['related','unrelated','uncertain'].includes(review.status)||typeof review.reason!=='string'||!review.reason.trim())throw Error('相关性判断需要结论和具体解释');
  if(!request.body_complete&&review.status!=='uncertain')throw Error('正文不足只能保留待确认');
  if(!Array.isArray(review.evidence)||review.evidence.some(x=>typeof x!=='string'||!x.trim()))throw Error('相关性判断需要 JD 引文数组');
  const body=[request.title,request.description,request.requirements].join('\n');
  if(review.status!=='uncertain'&&!review.evidence.length||review.evidence.some(x=>!body.includes(x)))throw Error('相关性依据必须来自本次 JD 原文');
  return {job_key:review.job_key,job_fingerprint:review.job_fingerprint,target_fingerprint:review.target_fingerprint,rule_version:RELEVANCE_VERSION,status:review.status,reason:review.reason,evidence:review.evidence};
}
