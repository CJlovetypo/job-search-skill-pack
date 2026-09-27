import path from 'node:path';
import {readJson,writeJson,workspacePath} from '../../shared/job-search-core/scripts/lib/io.mjs';
import {relevanceRequest,relevanceKey,validateRelevance} from '../../shared/job-search-core/scripts/lib/role-relevance.mjs';

export async function syncRoleReviews(directory,{items=[],requireComplete=false}={}) {
 const dir=workspacePath(directory),run=await readJson(path.join(dir,'run.json'));
 const query=run.query_snapshot;
 if(query?.retrieval?.mode!=='exhaustive'||!query.roles?.length)return {required:false,items:[],pending:0};
 const storeFile=path.join(dir,'role-reviews.json'),store=await readJson(storeFile,{reviews:{}}),requests=new Map(),snapshots=[];
 for(const c of run.companies.filter(c=>c.selected)){
  const file=path.join(dir,'companies',c.company_id+'.json'),snapshot=await readJson(file,null);if(!snapshot)continue;
  for(const j of snapshot.jobs){
   const base=j.role_base_status||j.evaluation_status;
   if(String(base).startsWith('excluded_'))continue;
   const request=relevanceRequest({...j,company_id:c.company_id},query);requests.set(relevanceKey(request),request);
  }
  snapshots.push({file,snapshot,company:c});
 }
 const next=structuredClone(store.reviews);
 for(const item of items){const key=relevanceKey(item),request=requests.get(key);if(!request)throw Error('岗位不属于本轮相关性待办');const value=validateRelevance(item,request);if(next[key]&&JSON.stringify(next[key])!==JSON.stringify(value))throw Error('重复提交的相关性判断冲突');next[key]=value;}
 if(items.length)await writeJson(storeFile,{reviews:next});
 const pending=[...requests].filter(([key])=>!next[key]).map(([key,r])=>({key,...r}));
 for(const {file,snapshot,company}of snapshots){
  for(const j of snapshot.jobs){
   const key=relevanceKey(relevanceRequest({...j,company_id:company.company_id},query));if(!requests.has(key))continue;
   j.role_base_status ||= j.evaluation_status;
   j.role_relevance=next[key]||{status:'pending'};
   j.evaluation_status=!next[key]?'awaiting_role_review':next[key].status==='unrelated'?'excluded_role':next[key].status==='uncertain'?'needs_verification':j.role_base_status;
  }
  snapshot.counts={...snapshot.counts,to_assess:snapshot.jobs.filter(j=>j.evaluation_status==='to_assess').length,role_pending:snapshot.jobs.filter(j=>j.role_relevance?.status==='pending').length,role_uncertain:snapshot.jobs.filter(j=>j.role_relevance?.status==='uncertain').length,role_excluded:snapshot.jobs.filter(j=>j.evaluation_status==='excluded_role').length};
  await writeJson(file,snapshot);
 }
 run.role_review={pending:pending.length,reviewed:requests.size-pending.length,total:requests.size};
 if(pending.length)run.status='awaiting_role_review';
 else if(run.status==='awaiting_role_review')run.status=run.purpose==='discover'?'discovery_collected':'awaiting_evaluation_scope';
 await writeJson(path.join(dir,'run.json'),run);
 if(requireComplete&&pending.length)throw Error(`全文职能相关性还有 ${pending.length} 条待审，请先 role-review-export / role-review-submit；可先交付标明待审的发现清单。`);
 return {required:true,run:dir,pending:pending.length,reviewed:requests.size-pending.length,items:pending};
}
