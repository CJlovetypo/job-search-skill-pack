import {collectHuatie} from './provider-huatie.mjs';
import {collectIqvia} from './provider-iqvia.mjs';
import {collectRecoveredDirection} from './providers-direction-recovered.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {collectCommon} from './providers-common.mjs';import {collectCustom} from './providers-custom.mjs';
import {collectInternational} from './providers-international.mjs';import {collectMidea} from './providers-appliances.mjs';import {collectOemPublic} from './providers-oem.mjs';
import {collectTupu360} from './provider-tupu360.mjs';
import {collectMoseeker} from './provider-moseeker.mjs';
import {collectPhenom} from './provider-phenom.mjs';
import {collectEightfold} from './provider-eightfold.mjs';
import {collectAvature} from './provider-avature.mjs';
import {collectAjinga} from './provider-ajinga.mjs';
import {collectJobs2web} from './provider-jobs2web.mjs';
import {collectIcimsJibe} from './providers-icims-jibe.mjs';
import {collectHardwareDirect} from './provider-hardware-direct.mjs';import {collectHuawei} from './provider-huawei.mjs';import {collectLenovo} from './provider-lenovo.mjs';import {collectCvte} from './provider-cvte.mjs';import {collectUgreen} from './provider-ugreen.mjs';
import {collectRecovered} from './providers-recovered.mjs';import {collectOracleNowcoder} from './providers-oracle-nowcoder.mjs';import {collectXYZ} from './providers-51job-xyz.mjs';
import {collectLightbolt} from './provider-lightbolt.mjs';
import {collectSf} from './providers-sf.mjs';
import {collectHcmCloud} from './provider-hcmcloud.mjs';
import {collectShlab} from './provider-shlab.mjs';
import {collectYokaverse} from './provider-yokaverse.mjs';
import {collectSelfHosted} from './providers-selfhosted.mjs';
import {collectRound3} from './providers-round3.mjs';
import {collectRound4} from './providers-round4.mjs';
import {directionSources} from './source-directions.mjs';
import {SEARCH_MODE,MODE_POLICY_VERSION,searchMode} from './search-mode.mjs';
import {reviewRecruitment} from './recruitment-policy.mjs';
import {normalizeJobLocations,jobCityStatus} from './locations.mjs';
import {searchPlanFingerprint} from './targeted-search.mjs';
import {sourceConfigFingerprint} from './source-fingerprint.mjs';
export {sourceConfigFingerprint};
function needsTargetBody(job,options){const loc=normalizeJobLocations(job);return job.formal_status===searchMode(options.targetMode||SEARCH_MODE.id).status&&job.open_status==='open'&&!job.body_complete&&job.detail_skipped_reason!=='explicit_non_target_city'&&jobCityStatus({cities:loc.cities,location_unknown:loc.unknown,location_special:loc.special},options.cities||[])!=='excluded';}
function enforceListOnlyCoverage(result,options){
 if(options.mode!=='list'&&result.coverage?.capability==='public_list_only'&&(result.jobs||[]).some(j=>!j.body_complete)){
  if(result.coverage.status==='complete')result.coverage.status='partial';
  result.coverage.collection_complete=false;
  result.coverage.reason=[result.coverage.reason,'job_details_not_collected'].filter(Boolean).join('; ');
 }
 return result;
}
const hardware={iqvia_public:collectIqvia,huatie_public:collectHuatie,ajinga_public:collectAjinga,jobs2web_public:collectJobs2web,tupu360:collectTupu360,moseeker_public:collectMoseeker,phenom_public:collectPhenom,eightfold_public:collectEightfold,avature_public:collectAvature,workday:collectInternational,smartrecruiters:collectInternational,icims_jibe:collectIcimsJibe,midea:collectMidea,huawei:collectHuawei,lenovo:collectLenovo,cvte:collectCvte,ugreen:collectUgreen,gree:collectHardwareDirect,dahua:collectHardwareDirect,hikvision:collectHardwareDirect,tplink:collectHardwareDirect,byd_public:collectOemPublic,lixiang_public:collectOemPublic,sinotruk_public:collectOemPublic,aion_public:collectOemPublic};
async function collectOriginalEndpoint(source,options){const recovered=await collectRecoveredDirection(source,options);if(recovered)return recovered;const result=source.provider==='shlab_public'?await collectShlab(source,options):source.provider==='hcmcloud_public'?await collectHcmCloud(source,options):source.provider==='sf_campus'?await collectSf(source,options):source.provider==='beisen_lightbolt'?await collectLightbolt(source,options):source.provider==='yokaverse'?await collectYokaverse(source,options):hardware[source.provider]?await hardware[source.provider](source,options):await collectRound4(source,options)||await collectRound3(source,options)||await collectSelfHosted(source,options)||await collectRecovered(source,options)||await collectOracleNowcoder(source,options)||await collectXYZ(source,options)||await collectCommon(source,options)||await collectCustom(source,options);if(!result)throw Error('未配置该来源采集器：'+source.provider);return enforceListOnlyCoverage(result,options);}
async function collectRoutedEndpoint(source,options={}) {
 const mode=options.targetMode||SEARCH_MODE.id;
 if(mode==='campus')return collectOriginalEndpoint(source,options);
 const routed=await directionSources(source,{...options,targetMode:mode}),results=[];
 for(const [i,route] of routed.sources.entries()) {
  const current={...route,source_id:(source.source_id||source.provider)+'-direction-'+i};let result;
  try {result=await collectOriginalEndpoint(current,{...options,targetMode:mode,evidenceDir:options.evidenceDir?path.join(options.evidenceDir,'direction-'+i):undefined});}
  catch(error){result={company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs:[],requests:[],coverage:{status:'failed',pages:0,reason:error.message}};}
  result.jobs=(result.jobs||[]).map(j=>reviewRecruitment(j,mode));results.push({source:current,result});
 }
 const result=results.length===1?results[0].result:mergeSourceResults(source,results,{...options,targetMode:mode});
 const missing=options.mode==='full'?result.jobs.filter(j=>needsTargetBody(j,{...options,targetMode:mode})).length:0;
 if(missing&&result.coverage.status==='complete')result.coverage.status='partial';
 result.coverage.collection_complete=result.coverage.status==='complete';
 result.coverage.direction={mode,...routed.plan,target_jobs_observed:result.jobs.filter(j=>j.formal_status===searchMode(mode).status).length,required_incomplete_bodies:missing};
 if(routed.plan.limitation){result.coverage.reason+='; '+routed.plan.limitation;if(result.coverage.status==='complete')result.coverage.status='partial';}
 result.requests=[...routed.requests,...result.requests||[]];return result;
}
export async function collectEndpoint(source,options={}){
 if(source.identity_verification?.identity_verified===false)return {company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs:[],requests:[],coverage:{status:'failed',pages:0,reason:'source_identity_not_verified: '+(source.identity_verification.basis||'explicit identity verification failure')}};
 let result;
 try{result=await collectRoutedEndpoint(source,options);}catch(e){result={company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs:[],requests:[],coverage:{status:'failed',pages:0,reason:e.message}};}
 return result;
}
export function sourceCacheMatches(result,company,searchPlan=null){
 if(searchPlan){if(result.search_plan_fingerprint!==searchPlanFingerprint(searchPlan))return false;}
 else if(result.search_plan_fingerprint||result.search_mode==='targeted')return false;
 if(result.source_config_fingerprint)return !!company&&result.source_config_fingerprint===sourceConfigFingerprint(company);
 // Legacy single-entry snapshots remain reusable; merged source lists must be collected once.
 return SEARCH_MODE.id==='campus'&&!company?.recruitment_sources?.length;
}
function jobNamespace(source){
 if(source.job_namespace)return source.provider+':reviewed:'+source.job_namespace;
 const entry=source.primary_entry_url?new URL(source.primary_entry_url):null;
 const cfg=source.api_config||{};
 if(source.provider==='workday'&&cfg.tenant&&cfg.site)return 'workday:'+cfg.tenant+':'+cfg.site;
 if(source.provider==='smartrecruiters'&&cfg.company_identifier)return 'smartrecruiters:'+cfg.company_identifier;
 if(source.provider==='ashby'&&cfg.board_token)return 'ashby:'+cfg.board_token;
 const publicTenant=source.provider==='51job_coapi'?cfg.ctmid:source.provider==='51job_xyz'?cfg.ehire_ctm_id:source.provider==='zhaopin_grace'?cfg.org_number:source.provider==='greenhouse'?cfg.board_token:source.provider==='moseeker_public'?cfg.company_id:source.provider==='phenom_public'?cfg.origin:source.provider==='eightfold_public'?[cfg.origin,cfg.domain].join(':'):source.provider==='avature_public'?[cfg.origin,cfg.search_path].join(':'):source.provider==='nowcoder_public'?cfg.company_id:source.provider==='oracle_recruiting'?[cfg.origin,cfg.site].join(':'):null;
 if(publicTenant)return source.provider+':'+publicTenant;
 const list=source.validated_api_request_examples?.find(q=>/list|search/i.test(q.purpose||''));
 // Portal aliases can share a tenant; otherwise keep different hosts separate.
 const tenant=source.provider==='moka'?(list?.body?.orgId||entry?.pathname.match(/\/(?:campus-recruitment|social-recruitment|apply)\/([^/]+)/)?.[1]):source.provider==='hotjob'?entry?.pathname.match(/\/(SU[a-zA-Z0-9]+)/)?.[1]:null;
 return source.provider+':'+(tenant||entry?.origin||'fixture');
}
export function mergeSourceResults(company,results,options={}){
 const stored=new Map(),requests=[],contexts=[];
 const primary=jobNamespace(company.primary_entry_url?company:results.find(r=>r.source.provider===company.provider)?.source||company);
 const namespaces=new Map();for(const {source} of results){if(!namespaces.has(source.provider))namespaces.set(source.provider,new Set());namespaces.get(source.provider).add(jobNamespace(source));}
 for(const {source,result} of results){requests.push(...(result.requests||[]));contexts.push({source_id:source.source_id,provider:source.provider,entry_url:source.primary_entry_url,...result.coverage});
  const namespace=jobNamespace(source),prefix=namespace===primary?'':source.provider!==company.provider&&namespaces.get(source.provider).size===1?source.provider+':':source.provider+':'+createHash('sha256').update(namespace).digest('hex').slice(0,12)+':';
  for(const raw of result.jobs||[]){const original=String(raw.job_id),key=namespace+':'+original,id=prefix+original;
   const job={...raw,job_id:id,source_job_id:original,source_provider:source.provider,source_job_namespace:namespace,source_ids:[source.source_id],company_id:company.company_id,company_name:company.display_name,raw_file:raw.raw_file||raw.evidence_files?.at(-1)};
   const previous=stored.get(key);if(!previous){stored.set(key,job);continue;}
   const sourceIds=[...new Set([...previous.source_ids,source.source_id])],a=previous.formal_status,b=job.formal_status;
   const types=[...new Set([...(previous.recruitment_evidence?.conflicting_recruitment_types||[]),a,b].filter(t=>t&&t!=='unknown'))],conflict=types.length>1;
   const current=(!previous.body_complete&&job.body_complete)||(previous.body_complete===job.body_complete&&!conflict&&a==='unknown'&&b!=='unknown')?job:previous;
   stored.set(key,{...current,source_ids:sourceIds,...conflict?{formal_status:'unknown',recruitment_evidence:{...current.recruitment_evidence,conflicting_recruitment_types:types,type_conflict:{sources:sourceIds,types}}}:{}});
  }
 }
 const jobs=[...stored.values()],failed=contexts.filter(x=>x.status==='failed').length,incomplete=options.mode==='list'?0:jobs.filter(j=>needsTargetBody(j,options)).length;
 const status=contexts.length&&contexts.every(x=>x.status==='complete')&&!incomplete?'complete':failed===contexts.length?'failed':'partial';
 return {company_id:company.company_id,display_name:company.display_name,checked_at:new Date().toISOString(),jobs,requests,coverage:{status,collection_complete:contexts.length>0&&contexts.every(c=>c.status==='complete'||c.collection_complete===true)&&!incomplete,pages:contexts.reduce((n,c)=>n+(typeof c.pages==='number'?c.pages:c.pages?.length||0),0),server_total:null,jobs_observed:jobs.length,contexts,reason:contexts.map(c=>`${c.provider}/${c.source_id}: ${c.reason||c.status}`).join('; ')+(incomplete?`; ${incomplete} observed jobs have incomplete or unresolved JD sections`:''),details_failed:contexts.reduce((n,c)=>n+(c.details_failed||0),0)}};
}
export async function collectCompanySources(company,options={},collector=collectEndpoint){
 if(!company.provider&&!company.recruitment_sources?.length)return {company_id:company.company_id,jobs:[],requests:[],coverage:{status:'unavailable',reason:'company_has_no_runnable_sources',pages:0,collection_complete:false}};
 options={...options,targetMode:options.targetMode||SEARCH_MODE.id};
 const fingerprint=sourceConfigFingerprint(company,options.targetMode);
 if(!company.recruitment_sources?.length){const result=await collector(company,options);return {...result,source_config_fingerprint:fingerprint};}
 const results=[];for(const config of company.recruitment_sources){const source={...config,company_id:company.company_id,display_name:company.display_name};try{results.push({source,result:await collector(source,{...options,evidenceDir:options.evidenceDir?path.join(options.evidenceDir,source.source_id):undefined})});}catch(e){results.push({source,result:{jobs:[],requests:[],coverage:{status:'failed',reason:String(e.message||e),pages:0}}});}}
 return {...mergeSourceResults(company,results,options),source_config_fingerprint:fingerprint};
}
