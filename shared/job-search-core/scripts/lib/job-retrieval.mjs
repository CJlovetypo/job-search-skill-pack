import {collectTargeted} from './collect-targeted.mjs';
import {collectCompanySources} from './source-collector.mjs';
import {reviewRecruitment} from './recruitment-policy.mjs';
import {reviewJobBody} from './body-review.mjs';
import {reconcileTargetJob} from './target-api-proof.mjs';
import {normalizeJobLocations} from './locations.mjs';
import {runtimeContext} from '../../runtime-context.mjs';
export function normalizeRetrievedJob(job,company,mode){
  job=reviewRecruitment(job,mode);
  if(!job.body_complete&&!['manual_full_record_review','model_full_available_body_and_local_evidence_review'].includes(job.body_review?.method))job=reviewJobBody(job);
  job=reconcileTargetJob(job,company,mode);const loc=normalizeJobLocations(job);
  return {...job,company_id:company.company_id,company_name:company.display_name,cities:loc.cities,location_special:loc.special,location_unresolved:loc.unresolved,location_unknown:loc.unknown,location_code_evidence:loc.code_evidence,location_structured_evidence:loc.structured_evidence||[],location_description_evidence:loc.description_evidence,location_title_evidence:loc.title_evidence||[],locations_raw:loc.raw};
}
export async function retrieveCompany(company,query,{searchPlan,capabilities={},collector,...options}={}){
  const opts={...options,targetMode:query.mode,cities:query.city_filters,repairPolicy:options.repairPolicy||runtimeContext().repairPolicy,repair:options.repair!==false};
  if(query.retrieval.mode==='targeted'&&!searchPlan)throw Error('定向采集缺少已确认检索计划');
  const result=query.retrieval.mode==='targeted'?await collectTargeted(company,searchPlan,opts,capabilities,collector):await collectCompanySources(company,opts,collector);
  return {...result,jobs:(result.jobs||[]).map(j=>normalizeRetrievedJob(j,company,query.mode))};
}
