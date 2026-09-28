import {syncRoleReviews} from './role-review.mjs';
import {selectQueryCompanies} from '../../shared/job-search-core/scripts/lib/query-selection.mjs';
import {retrieveCompany,normalizeRetrievedJob} from '../../shared/job-search-core/scripts/lib/job-retrieval.mjs';
import {datasetPath,COMPANY_SIZE_FILE,SEARCH_CAPABILITIES_FILE} from '../../shared/job-search-core/registry.mjs';
import {PACK_ROOT,recruitmentFile} from '../../shared/job-search-core/runtime-context.mjs';
import {loadCompanyContext} from '../../shared/job-search-core/scripts/lib/company-records.mjs';
import {normalizeBusinessFilters,businessMatchMode,businessMatches,canonicalBusiness} from '../../shared/job-search-core/scripts/lib/business-taxonomy.mjs';
import {validateSearchPlan,searchPlanFingerprint} from '../../shared/job-search-core/scripts/lib/targeted-search.mjs';
import {collectTargeted} from '../../shared/job-search-core/scripts/lib/collect-targeted.mjs';
import {refreshedCityTag} from '../../shared/job-search-core/scripts/lib/city-index.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {SKILL_ROOT,readJson,writeJson,workspacePath,mapLimit,stamp,relative} from '../../shared/job-search-core/scripts/lib/io.mjs';
import {normalizeJobLocations,normalizeCityFilters,companyCityMatches,jobCityStatus} from '../../shared/job-search-core/scripts/lib/locations.mjs';
import {jobFingerprint} from '../../shared/job-search-core/scripts/lib/job-version.mjs';
import {reviewNeedsUpdate} from '../../shared/job-search-core/scripts/lib/reports.mjs';
import {ASSESSMENT_VERSION, MATCH_MATRIX} from '../../shared/job-search-core/scripts/lib/matching.mjs';
import {ownershipDatasetProblems, ownershipDisplayTag} from '../../shared/job-search-core/scripts/lib/ownership.mjs';
import {profileFingerprint, profileEvidenceProblem} from '../../shared/job-search-core/scripts/lib/evidence-model.mjs';
import {reviewRecruitment, restoreRequestRecruitmentEvidence, verificationIssues} from '../../shared/job-search-core/scripts/lib/recruitment-policy.mjs';
import {reviewJobBody} from '../../shared/job-search-core/scripts/lib/body-review.mjs';
import {screeningSummary, readEvaluationScope, inEvaluationScope, planAssessment} from '../../shared/job-search-core/scripts/lib/evaluation-scope.mjs';
import {writeJdArchive} from '../../shared/job-search-core/scripts/lib/jd-archive.mjs';
import {companyProfileSnapshot, saveCompanyProfileSnapshot} from '../../shared/job-search-core/scripts/lib/company-profiles.mjs';
import {INDUSTRIES,normalizeIndustries,industryMatches,industryLabels} from '../../shared/job-search-core/scripts/lib/industry-routing.mjs';
import {collectCompanySources,sourceCacheMatches,sourceConfigFingerprint} from '../../shared/job-search-core/scripts/lib/source-collector.mjs';
import {SEARCH_MODE,isTargetJob,knownOtherType,modeProfileProblem,eligibilityPolicy} from '../../shared/job-search-core/scripts/lib/search-mode.mjs';
import {validatedDirectionRegistry} from '../../shared/job-search-core/scripts/lib/direction-validation.mjs';
import {reconcileTargetJob} from '../../shared/job-search-core/scripts/lib/target-api-proof.mjs';
import {assertTaskExecution,assertTaskScope,assertScopeRevision,taskFingerprint} from '../../shared/job-search-core/scripts/lib/task-decision.mjs';
import {isV5,MODEL_VERSION,modelVersion,allowLocationReview,V5_INSTRUCTION} from '../../shared/job-search-core/scripts/lib/assessment-v5.mjs';
const [command,...args]=process.argv.slice(2);
const BATCH_HELP='batch-create --run 运行目录 [--limit 50] [--max-chars 160000] [--concurrency 4] [--jobs 岗位键数组.json]\nbatch-start --run 运行目录 --batch ID --agent ID\nbatch-submit --run 运行目录 --batch ID --agent ID --file 草稿.json\nbatch-merge --run 运行目录 --batch ID\nbatch-close --run 运行目录 --batch ID --agent ID --stopped [--usage-log 会话.jsonl]\nbatch-status --run 运行目录 [--refresh]\nstart/close 可传实际工具调用 --tool-started-at ISO时间 --tool-finished-at ISO时间';
const flags={};for(let i=0;i<args.length;i++){if(command==='company-profiles'&&i===0&&args[i]==='status')continue;if(!args[i].startsWith('--'))throw new Error('未知参数 '+args[i]);const key=args[i].slice(2);flags[key]=args[i+1]&&!args[i+1].startsWith('--')?args[++i]:true;}
const companyContext=await loadCompanyContext();
const companyRecordsById=new Map(companyContext.records.companies.map(c=>[c.company_id,c]));
const originalSources=companyContext.registry.companies;
const directionValidation=SEARCH_MODE.id==='campus'?null:await readJson(recruitmentFile(SEARCH_MODE.id,'source-direction-validation.json'),null);
const registryGate=validatedDirectionRegistry(originalSources,directionValidation,SEARCH_MODE.id),sources=registryGate.companies;
const cityFile=recruitmentFile(SEARCH_MODE.id);
const businessFile=datasetPath(SKILL_ROOT,'data/company-business-tags.json');
const ownershipFile=datasetPath(SKILL_ROOT,'data/company-ownership-tags.json');
let searchCapabilities;
function enrich(job,source){return normalizeRetrievedJob(job,source,SEARCH_MODE.id);}
function businessAlignment(source,tag,profile) {
 const wanted=profile.business_preferences||[],avoided=profile.avoid_business_tags||[],actual=tag?.business_tags||[];
 if (!wanted.length&&!avoided.length)return {status:'not_set',reason:'未设置公司业务倾向'};
 if (avoided.some(t=>businessMatches(actual,[canonicalBusiness(t)||t])))return {status:'mismatch',reason:'命中用户不希望优先的业务标签'};
 if (!actual.length||tag?.status==='unknown')return {status:'unknown',reason:'公司业务标签尚未确认'};
 if (!wanted.length)return {status:'aligned',reason:'未命中用户不希望优先的业务标签'};
 const matches=wanted.filter(t=>businessMatches(actual,[canonicalBusiness(t)||t]));const aligned=profile.business_match==='all'?matches.length===wanted.length:matches.length>0;
 return {status:aligned?'aligned':'mismatch',reason:aligned?'业务标签符合：'+matches.join('、'):'公司业务标签与本次倾向不符'};
}
function ownershipChoices(value) {
 if(value==null)return [];
 if(!Array.isArray(value)||value.some(x=>!['国企','私企','外企'].includes(x)))throw Error('公司性质筛选只接受国企、私企、外企数组');
 return [...new Set(value)];
}
function ownershipAlignment(entry,profile) {
 const wanted=ownershipChoices(profile.ownership_preferences);
 if(!wanted.length)return {status:'not_set',reason:'未设置公司性质倾向'};
 const actual=ownershipDisplayTag(entry);
 if(actual==='待核实')return {status:'unknown',reason:'公司性质待核实'};
 return wanted.includes(actual)?{status:'aligned',reason:'公司性质符合：'+actual}:{status:'mismatch',reason:'公司性质与本次倾向不符：'+actual};
}
function staticChoices(value,label) {
 if(value==null)return [];
 const values=Array.isArray(value)?value:String(value).split(',');
 if(values.some(x=>typeof x!=='string'||!x.trim()))throw Error(label+'筛选需要非空字符串数组');
 return [...new Set(values.map(x=>x.trim()))];
}
function staticFieldValue(companyId,field) {
 const record=companyRecordsById.get(companyId);
 return record?.tags?.[field]??null;
}
const preferenceRank=company=>(company.ownership_alignment?.status==='aligned'?0:company.ownership_alignment?.status==='unknown'?1:2)+(company.business_alignment?.status==='aligned'?0:company.business_alignment?.status==='unknown'?1:2);
async function collect(source,options) {
 try {return await retrieveCompany(source,{mode:SEARCH_MODE.id,city_filters:options.cities||[],retrieval:{mode:options.searchPlan?'targeted':'exhaustive'}},{...options,capabilities:await (searchCapabilities??=readJson(SEARCH_CAPABILITIES_FILE,{configurations:[]}))});}
 catch(e){return {company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs:[],coverage:{status:'failed',pages:0,server_total:null,jobs_observed:0,reason:String(e.message||e)},requests:[]};}
}
function chooseSources(industryFilters,companyFilters,ownershipFilters,headquartersFilters,listingFilters,businessFilters=[],businessMode='any') {
 const query={mode:SEARCH_MODE.id,industry_filters:industryFilters||flags.industries&&normalizeIndustries(String(flags.industries))||['all'],company_filters:flags.only?String(flags.only).split(','):companyFilters||[],ownership_filters:ownershipFilters||[],headquarters_country_filters:headquartersFilters||[],listing_status_filters:listingFilters||[],business_filters:businessFilters,business_filter_match:businessMode};
 let selected=selectQueryCompanies(companyContext,query,{applyCities:false}).companies;
 if(flags.providers)selected=selected.filter(s=>String(flags.providers).split(',').some(p=>p===s.provider||s.recruitment_sources?.some(c=>c.provider===p)));
 return selected;
}
async function catalog(){
 const profile=flags.profile?await readJson(path.resolve(String(flags.profile))):{},filters=normalizeIndustries(flags.industries||profile.industry_filters||(normalizeBusinessFilters(flags.businesses??profile.business_filters).length?['all']:undefined)),cityFilters=normalizeCityFilters(flags.cities?String(flags.cities).split(','):profile.city_filters||[]);
 ownershipChoices(profile.ownership_preferences);
 const headquartersFilters=staticChoices(flags['headquarters-countries']||profile.headquarters_country_filters,'总部国家'),listingFilters=staticChoices(flags['listing-statuses']||profile.listing_status_filters,'上市状态');
 const industryCount=chooseSources(filters,profile.company_filters).length;
 const ownershipCount=chooseSources(filters,profile.company_filters,profile.ownership_filters).length;
 let candidates=chooseSources(filters,profile.company_filters,profile.ownership_filters,headquartersFilters,listingFilters);const staticFilterCount=candidates.length;
 const businessFilters=normalizeBusinessFilters(flags.businesses??profile.business_filters),businessMode=businessMatchMode(flags['business-match']??profile.business_filter_match);
 candidates=chooseSources(filters,profile.company_filters,profile.ownership_filters,headquartersFilters,listingFilters,businessFilters,businessMode);
 const businessCount=candidates.length;
 const rawPlan=flags['search-plan']?await readJson(path.resolve(String(flags['search-plan']))):profile.search_plan;
 const searchPlan=rawPlan?validateSearchPlan(rawPlan,sources):null;
 if(searchPlan){const allowed=new Set(candidates.map(c=>c.company_id));if(searchPlan.company_ids.some(id=>!allowed.has(id)))throw Error('定向候选与行业或明确公司范围冲突');candidates=candidates.filter(c=>searchPlan.company_ids.includes(c.company_id));}
 const city=(companyContext.cities[SEARCH_MODE.id]||{companies:[],unavailable:true}),byId=new Map(city.companies.map(c=>[c.company_id,c])),selection=selectQueryCompanies({...companyContext,registry:{companies:candidates},cities:{[SEARCH_MODE.id]:city}},{...profile,mode:SEARCH_MODE.id,industry_filters:['all'],company_filters:[],city_filters:cityFilters}),selected=selection.companies;
const ownership=companyContext.ownership,ownershipById=new Map(ownership.companies.map(c=>[c.company_id,c])),businessById=new Map(companyContext.business.companies.map(c=>[c.company_id,c])),result={industries:industryLabels(filters),industry_filters:filters,ownership_filters:ownershipChoices(profile.ownership_filters),headquarters_country_filters:headquartersFilters,listing_status_filters:listingFilters,city_filters:cityFilters,industry_candidates:industryCount,excluded_by_ownership:industryCount-ownershipCount,excluded_by_static_company_filters:ownershipCount-staticFilterCount,selected_companies:selected.length,excluded_by_city:candidates.length-selected.length,ownership_pending:selected.filter(c=>!['verified','verified_unresolved','api_supported','demo_unreviewed'].includes(ownershipById.get(c.company_id)?.status)).map(c=>({company_id:c.company_id,display_name:c.display_name,problem:'现有性质标签待核实，不阻塞使用'})),ownership_api_supported:selected.filter(c=>['api_supported','demo_unreviewed'].includes(ownershipById.get(c.company_id)?.status)).map(c=>({company_id:c.company_id,display_name:c.display_name,review_state:ownershipById.get(c.company_id)?.status==='demo_unreviewed'?'首版画像，待独立复核':'待独立核实'})),source_validation:{...registryGate,companies:undefined},companies:selected.map(c=>({company_id:c.company_id,display_name:c.display_name,industry_tags:c.industry_tags,headquarters_country:staticFieldValue(c.company_id,'headquarters_country'),listing_status:staticFieldValue(c.company_id,'listing_status'),ownership_tag:ownershipDisplayTag(ownershipById.get(c.company_id)),ownership_status:ownershipById.get(c.company_id)?.status||'unknown',ownership_alignment:ownershipAlignment(ownershipById.get(c.company_id),profile),business_tags:businessById.get(c.company_id)?.business_tags||[],business_alignment:businessAlignment(c,businessById.get(c.company_id),profile),cities:byId.get(c.company_id)?.cities||[],city_index_updated_at:byId.get(c.company_id)?.updated_at||null})).sort((a,b)=>preferenceRank(a)-preferenceRank(b)),next_step:'可 prepare 后采集岗位，再沿用评估范围确认流程；公司标签直接使用已有记录。'};
 const size=companyContext.size,sizeById=new Map(size.companies.map(c=>[c.company_id,c]));
 result.company_catalog=companyContext.catalog;
 Object.assign(result,{business_filters:businessFilters,business_filter_match:businessMode,excluded_by_business:staticFilterCount-businessCount});
 for(const company of result.companies)company.business_status=companyRecordsById.get(company.company_id).governance.fields['tags.business'].status;
 for(const company of result.companies)company.size_tag=sizeById.get(company.company_id)||{label:'待核实',reason:'暂无规模证据'};
 result.retrieval_mode=searchPlan?'targeted':'exhaustive';if(searchPlan){result.search_plan=searchPlan;result.excluded_by_targeted_plan=ownershipCount-candidates.length;}
 if(flags.out)await writeJson(workspacePath(path.resolve(String(flags.out))),result);console.log(JSON.stringify(result));
}
function integer(name,fallback,max) {const v=Number(flags[name]??fallback);if(!Number.isInteger(v)||v<1||v>max)throw new Error('--'+name+' 超出范围');return v;}
function applyJobScope(result,filters) {
 const counts={total:result.jobs.length,nonformal:0,not_open:0,other_city:0,needs_verification:0,incomplete_body:0,to_assess:0};
 for(const j of result.jobs){
  j.jd_fingerprint=jobFingerprint(j);
  j.city_status=jobCityStatus(j,filters);
  if(knownOtherType(j)){j.evaluation_status='excluded_nonformal';counts.nonformal++;}
  else if(j.open_status==='closed'){j.evaluation_status='excluded_closed';counts.not_open++;}
  else if(j.city_status==='excluded'){j.evaluation_status='excluded_city';counts.other_city++;}
  else if(j.formal_status!==SEARCH_MODE.status||j.open_status!=='open'||j.city_status==='unknown'){j.evaluation_status='needs_verification';counts.needs_verification++;}
  else if(!j.body_complete){j.evaluation_status='missing_body';counts.incomplete_body++;}
  else {j.evaluation_status='to_assess';counts.to_assess++;}
  j.verification_issues=['needs_verification','missing_body'].includes(j.evaluation_status)?verificationIssues(j):[];
 }
 result.counts=counts;return result;
}

async function prepare() {
 if(!flags.profile)throw new Error('prepare 需要 --profile（由 skill 按用户材料整理）');
 const discovery=flags.discovery===true;
 const profile=await readJson(path.resolve(String(flags.profile)));profile.city_filters=normalizeCityFilters(profile.city_filters||[]);
 ownershipChoices(profile.ownership_preferences);ownershipChoices(profile.ownership_filters);
 if(!discovery){profile.assessment_model_version=MODEL_VERSION;profile.evidence??=[];}
 if(!discovery&&SEARCH_MODE.id!=='campus'){const problem=modeProfileProblem(profile);if(problem)throw Error(problem);profile.search_mode=SEARCH_MODE.id;}
 if(profile.search_mode&&profile.search_mode!==SEARCH_MODE.id)throw Error('画像招聘方向与当前 Skill 不一致');
 profile.industry_filters=normalizeIndustries(profile.industry_filters||(normalizeBusinessFilters(profile.business_filters).length?['all']:undefined));
 profile.headquarters_country_filters=staticChoices(profile.headquarters_country_filters,'总部国家');profile.listing_status_filters=staticChoices(profile.listing_status_filters,'上市状态');
 profile.business_filters=normalizeBusinessFilters(profile.business_filters);profile.business_filter_match=businessMatchMode(profile.business_filter_match);
 if(flags.businesses||flags['business-match'])throw Error('prepare 的业务硬筛选请写入 profile.business_filters/business_filter_match');
 let candidates=chooseSources(profile.industry_filters,profile.company_filters,profile.ownership_filters,profile.headquarters_country_filters,profile.listing_status_filters,profile.business_filters,profile.business_filter_match);
 const rawPlan=flags['search-plan']?await readJson(path.resolve(String(flags['search-plan']))):profile.search_plan;
 const searchPlan=rawPlan?validateSearchPlan(rawPlan,sources):null;
 if(searchPlan){const allowed=new Set(candidates.map(c=>c.company_id));if(searchPlan.company_ids.some(id=>!allowed.has(id)))throw Error('定向候选与行业或明确公司范围冲突');candidates=candidates.filter(c=>searchPlan.company_ids.includes(c.company_id));profile.search_plan=searchPlan;}
 const task=flags.task?await readJson(path.resolve(String(flags.task))):null;
 if(isV5(profile)&&!profile.city_preference){const c=task?.conditions?.cities;profile.city_preference={state:c?.state|| (profile.city_filters.length?'explicit':'unspecified'),values:c?.value||profile.city_filters,importance:c?.importance||(profile.city_filters.length?'must':'open')};}
 if(task&&(flags.only||flags.providers))throw Error('绑定任务时请在任务与profile中记录公司范围，不能用 --only/--providers 暗中缩小');
 if(task)assertTaskExecution(task,profile,SEARCH_MODE.id,{discovery,searchPlan});
 if(!discovery){
 const evidence=profile.evidence||[];
 if(new Set(evidence.map(e=>e.id)).size!==evidence.length||evidence.some(e=>!e.id||!e.text))throw new Error('个人证据需要唯一 id 和具体 text');
 const profileProblem=profileEvidenceProblem(profile);if(profileProblem)throw new Error('个人画像需补齐证据分类：'+profileProblem);
 }
 const dir=workspacePath(flags.out?path.resolve(String(flags.out)):path.join(SKILL_ROOT,'runs',stamp()));
 if(await readJson(path.join(dir,'run.json'),null))throw new Error('该运行目录已存在，请使用新目录；继续采集用 collect --run');
 const city=(companyContext.cities[SEARCH_MODE.id]||{companies:[],unavailable:true});
 const selection=selectQueryCompanies({...companyContext,registry:{companies:candidates},cities:{[SEARCH_MODE.id]:city}},{...profile,mode:SEARCH_MODE.id,industry_filters:['all'],company_filters:[]}),selectedCompanyIds=new Set(selection.companies.map(c=>c.company_id));
 const business=companyContext.business,ownership=companyContext.ownership;const cities=new Map((city?.companies||[]).map(c=>[c.company_id,c]));const businesses=new Map(business.companies.map(c=>[c.company_id,c]));const ownerships=new Map(ownership.companies.map(c=>[c.company_id,c]));
 const companies=candidates.map(s=>{const t=cities.get(s.company_id),b=businesses.get(s.company_id),o=ownerships.get(s.company_id);return {company_id:s.company_id,display_name:s.display_name,industry_tags:s.industry_tags,selected:selectedCompanyIds.has(s.company_id),city_tags:t?.cities||[],city_index_updated_at:t?.updated_at||null,city_coverage_complete:t?.city_coverage_complete||false,business_tags:b?.business_tags||[],business_summary:b?.business_summary||'',business_alignment:businessAlignment(s,b,profile),ownership_alignment:ownershipAlignment(o,profile),ownership_tag:ownershipDisplayTag(o),ownership_source_tag:o?.ownership_tag||null,ownership_status:o?.status||'unknown',ownership_reason:o?.reason||'',ownership_evidence:o?.evidence||[],ownership_checked_at:o?.checked_at||null,selection_reason:selectedCompanyIds.has(s.company_id)?'行业、公司性质与城市范围入选':'当前公司城市标签未命中；本轮直接排除'};});
 const ownershipOrigins=new Map(companyContext.records.companies.map(r=>[r.company_id,r.governance.fields['tags.ownership'].origin]));
 for(const company of companies)company.ownership_origin=ownershipOrigins.get(company.company_id)||'legacy_import';
 const run={schema_version:2,created_at:new Date().toISOString(),profile,profile_fingerprint:profileFingerprint(profile),companies,selection_summary:{industry_filters:profile.industry_filters,industry_labels:industryLabels(profile.industry_filters),ownership_filters:ownershipChoices(profile.ownership_filters),ownership_preferences:ownershipChoices(profile.ownership_preferences),registered_companies:sources.length,industry_candidates:sources.filter(s=>industryMatches(s,profile.industry_filters)).length,excluded_by_industry:sources.filter(s=>!industryMatches(s,profile.industry_filters)).length,company_filters:profile.company_filters||flags.only?.split(',')||[],city_excluded:companies.filter(c=>!c.selected).length},city_index_updated_at:city?.updated_at||null,status:'prepared',is_test:profile.is_test===true};
 run.purpose=discovery?'discover':'match';run.query_snapshot={...profile,mode:SEARCH_MODE.id,roles:task?.conditions?.roles?.value||[],retrieval:task?.retrieval||{mode:searchPlan?'targeted':'exhaustive',selection:'inherited',basis:'既有运行选择'}};
 Object.assign(run.selection_summary,{business_filters:profile.business_filters,business_filter_match:profile.business_filter_match});
 for(const company of companies)company.business_status=companyRecordsById.get(company.company_id).governance.fields['tags.business'].status;
 if(task){run.task_snapshot=task;run.task_fingerprint=taskFingerprint(task);}
 if(SEARCH_MODE.id!=='campus')run.search_mode=SEARCH_MODE.id;
 if(searchPlan){run.search_plan=searchPlan;run.search_plan_fingerprint=searchPlanFingerprint(searchPlan);run.retrieval_mode='targeted';run.selection_summary.targeted_company_excluded=sources.length-candidates.length;}
 const selectedIds=new Set(companies.map(c=>c.company_id));
 await writeJson(path.join(dir,'company-records.snapshot.json'),{...companyContext.records,companies:companyContext.records.companies.filter(c=>selectedIds.has(c.company_id))});
 const profileSnapshot=await companyProfileSnapshot(dir,companies,companyContext);
 await saveCompanyProfileSnapshot(dir,profileSnapshot);
 await writeJson(path.join(dir,'run.json'),run);await fs.mkdir(path.join(dir,'assessments'),{recursive:true});
 if(flags['reuse-run']){
  const previous=workspacePath(path.resolve(String(flags['reuse-run'])));
  for(const c of companies.filter(c=>c.selected)){
   const old=await readJson(path.join(previous,'companies',c.company_id+'.json'),null);
   const current=sources.find(s=>s.company_id===c.company_id);
   if(old&&sourceCacheMatches(old,current,searchPlan)){old.jobs=old.jobs.map(job=>enrich(restoreRequestRecruitmentEvidence(job,old.requests||[]),c));await writeJson(path.join(dir,'companies',c.company_id+'.json'),allowLocationReview(applyJobScope(old,profile.city_filters),profile));}
  }
 }
 console.log(JSON.stringify({run:dir,selected:companies.filter(c=>c.selected).length,excluded:companies.filter(c=>!c.selected).length}));
}
async function collectRun() {
 if(!flags.run)throw new Error('需要 --run');const dir=workspacePath(path.resolve(String(flags.run))),file=path.join(dir,'run.json'),run=await readJson(file);
 if((run.search_mode||'campus')!==SEARCH_MODE.id)throw Error('运行招聘方向与当前 Skill 不一致，不能复用其他方向的采集或评估');
 const batchState=await readJson(path.join(dir,'parallel/batches/state.json'),null);if(batchState?.batches.some(b=>!b.closed_at))throw new Error('仍有未关闭的固定批次；请先回收执行者再采集');
 if(batchState){batchState.needs_refresh=true;await writeJson(path.join(dir,'parallel/batches/state.json'),batchState);}
 await fs.rm(path.join(dir,'next-batch.json'),{force:true});
 const selected=run.companies.filter(c=>c.selected).sort((a,b)=>preferenceRank(a)-preferenceRank(b));
 await mapLimit(selected,integer('concurrency',3,8),async(c)=>{
  const p=path.join(dir,'companies',c.company_id+'.json');const existing=await readJson(p,null);
  const source=sources.find(s=>s.company_id===c.company_id);
  if(existing&&!flags.refresh&&(existing.coverage.status==='complete'||existing.coverage.collection_complete===true)&&sourceCacheMatches(existing,source,run.search_plan)&&!existing.jobs.some(j=>j.city_status==='included'&&!j.body_complete&&!knownOtherType(j)&&j.open_status!=='closed')){if(isV5(run.profile))await writeJson(p,allowLocationReview(existing,run.profile));return;}
  if(!source)throw Error('当前来源名单已无该公司，请核对历史运行范围：'+c.display_name);
  const result=await collect(source,{mode:'full',maxPages:integer('max-pages',1000,10000),pageSize:SEARCH_MODE.id==='campus'?20:50,timeoutMs:20000,evidenceDir:path.join(dir,'raw',c.company_id),cities:run.profile.city_filters,searchPlan:run.search_plan,refresh:flags.refresh===true});
  allowLocationReview(applyJobScope(result,run.profile.city_filters),run.profile);await writeJson(p,result);console.log(JSON.stringify({company:c.display_name,coverage:result.coverage.status,...result.counts}));
 });
 run.status=run.purpose==='discover'?'discovery_collected':(await readEvaluationScope(dir,{required:false}))?'evaluation_scope_confirmed':'awaiting_evaluation_scope';run.collected_at=new Date().toISOString();await writeJson(file,run);
 const roleReview=await syncRoleReviews(dir);
 const archive=await writeJdArchive(dir);
 const summary=await screeningSummary(dir);await writeJson(path.join(dir,'screening-summary.json'),summary);
 console.log(JSON.stringify({screening_summary:path.join(dir,'screening-summary.json'),total_to_assess:summary.total_to_assess,needs_verification:summary.needs_verification,jd_archive:archive.file,role_review_pending:roleReview.pending,next_step:roleReview.pending?'role-review-export → role-review-submit，再确认评估范围。':run.purpose==='discover'?'运行 render-discovery 交付尚未个人匹配的候选及覆盖。':'展示筛选结果，确认用户选择实验批次、指定公司或全量评估后，再 plan-assessment 与 next-batch；已有明确范围时复用。'}));
}
async function nextBatch(dir) {
 dir=workspacePath(dir||path.resolve(String(flags.run||'')));const scope=await readEvaluationScope(dir);const run=await readJson(path.join(dir,'run.json'));const pending=[];let total=0,done=0,fullTotal=0,fullDone=0;
 for(const c of run.companies.filter(c=>c.selected)){
  const result=await readJson(path.join(dir,'companies',c.company_id+'.json'),null);if(!result)continue;
  const reviews=(await readJson(path.join(dir,'assessments',c.company_id+'.json'),{assessments:[]})).assessments;const byId=new Map(reviews.map(r=>[String(r.job_id),r]));
  for(const job of result.jobs.filter(j=>j.evaluation_status==='to_assess')){fullTotal++;job.jd_fingerprint=jobFingerprint(job);const reason=reviewNeedsUpdate(byId.get(String(job.job_id)),job,run.profile);if(!reason)fullDone++;if(!inEvaluationScope(scope,c.company_id,job.job_id))continue;total++;if(!reason){done++;continue;}if(pending.length<integer('limit',20,100))pending.push({company:c,job,assessment_reason:reason});}
 }
 const file=path.join(dir,'next-batch.json');await writeJson(file,{
  profile:run.profile,profile_fingerprint:profileFingerprint(run.profile),profile_validation_issue:profileEvidenceProblem(run.profile),
  evaluation_contract:{
   assessment_version:modelVersion(run.profile),review_method:'full_jd',read_completely:['description','requirements','recruitment_evidence'],
   ability_values:['high','medium','low','unknown'],interest_values:['aligned','explore','conflict','unknown'],
   profile_binding:'每条评估必须写入本批 profile_fingerprint；画像变更后重新评估，禁止给旧结论补指纹。',
   ability_model_reference:'references/ability-model.md',reciprocal_model_reference:'references/reciprocal-model.md',
   interest_checks:'必填数组；覆盖重要偏好，每项 preference、importance(must/prefer/open)、status(met/partial/conflict/unknown)、user_basis、job_basis；无明确偏好可空数组且interest未知。业务偏好只在这里判断一次。',
   hard_condition:eligibilityPolicy(),
   action_fields:'新评估使用next_action(apply/prepare/hold)、priority、priority_reason；high另需timing_evidence。Excel只展示可以投递／投递前准备／暂不建议投递，不展示内部优先级或核实动作。轮岗、业务占比、提前实习等不确定项写入理由，但不能阻止形成投递建议。硬性条件明确不符、意愿冲突或能力为low时必须low+hold。',
   ability_reason:'解释对口实习／项目的个人贡献、成果与核心要求覆盖；按experience_id去重，同一实习拆多条不增加经历数量。',
   comparison_fields:{requirement_type:['core','supporting','bonus','eligibility'],support:['direct','transferable','unsupported'],evidence_strength:['strong','moderate','weak','none']},
   experience_relevance:'为引用的每段客观实习／工作经历记录experience_id、industry_relation、business_relation、role_relation（均为same/adjacent/different/unknown）及explanation；同业务跨岗位、同岗位跨业务保留部分对口价值，按具体JD判定。',
   report_summary:'必填conclusion/ability/interest/gaps四个非空字符串，分别概括评估结论、能力依据、个人意愿、主要缺口；面向读者写总结，保留资格及到岗限制，不罗列E1等编号或逐项分析。',
   evidence_rule:'同等相关性和质量下：实习优先于学校／个人项目，再看其他相关经历；客观经历／成就高于自评。高质量对口项目可支撑高能力，不按头衔、数量或关键词打分。',
   interest_reason:'interest 非 unknown 时必填非空字符串，说明用户明确职能、业务及重要条件或后续说明；能力证据不能代替意愿依据。',match_matrix:MATCH_MATRIX,
   instruction:isV5(run.profile)?V5_INSTRUCTION:'完整阅读每个岗位及个人画像后按v4独立评估能力和意愿，匹配层级由两者共同决定；禁止按标题、关键词或模板批量生成结论，禁止从旧匹配层级反推能力。',
   ...(isV5(run.profile)?{reference:'shared/job-search-core/references/assessment-v5.md',action_fields:'apply/prepare/hold/clarify，关键缺资料用clarify；参考年限和薪资不构成硬否决',hard_condition:'按assessment-v5.md拆分学历/专业/经验；年限仅参考，缺证未知',comparison_fields:{requirement_type:['core','supporting','bonus','eligibility'],status:['met','partial','conflict','unknown'],support:['direct','transferable','unsupported'],evidence_strength:['strong','moderate','weak','none']}}:{})
  },evaluation_scope:scope,pending,total_to_assess:total,already_assessed:done,remaining:total-done,
  full_total_to_assess:fullTotal,full_already_assessed:fullDone,full_remaining:fullTotal-fullDone,
  outside_scope_remaining:fullTotal-fullDone-(total-done)
 });console.log(JSON.stringify({batch:file,mode:scope.mode,items:pending.length,total,done,remaining:total-done,full_remaining:fullTotal-fullDone,outside_scope_remaining:fullTotal-fullDone-(total-done)}));
}
async function main(){
 if(command==='company-profiles'){
  if(args[0]!=='status')throw Error('公开公司资料仅支持 status 读取。');
  console.log(JSON.stringify({companies:companyContext.profiles.companies.length,source:'published_company_records',read_only:true}));return;
 }
 if(['repair-source','refresh-cities','company-maintenance'].includes(command))throw Error('该命令不属于公开产品；请使用正式数据版本。');
 if(['role-review-export','role-review-submit'].includes(command)){
  if(!flags.run)throw Error('需要 --run');
  const items=command==='role-review-submit'?(await readJson(path.resolve(String(flags.file)))).items:[];
  if(!Array.isArray(items))throw Error('提交需要 items 数组');
  const result=await syncRoleReviews(path.resolve(String(flags.run)),{items});
  if(flags.out)await writeJson(workspacePath(path.resolve(String(flags.out))),result);
  console.log(JSON.stringify(result));return;
 }

 if(flags.run){
  const dir=workspacePath(path.resolve(String(flags.run)));
  const run=await readJson(path.join(dir,'run.json'));
  if((run.search_mode||'campus')!==SEARCH_MODE.id)throw Error('运行招聘方向与当前 Skill 不一致，不能复用其他方向的采集或评估');
  if(run.task_snapshot&&run.task_fingerprint!==taskFingerprint(run.task_snapshot))throw Error('任务快照已变化，请新建任务修订和运行');
  if(run.task_snapshot){
   if(run.profile_fingerprint!==profileFingerprint(run.profile))throw Error('运行画像已变化，请保存新任务并 prepare 新运行');
   assertTaskExecution(run.task_snapshot,run.profile,SEARCH_MODE.id,{discovery:run.purpose==='discover',searchPlan:run.search_plan||null});
  }
  if(run.purpose==='discover'&&['next-batch','plan-assessment','batch-create','batch-start','batch-submit','batch-merge','render'].includes(command))throw Error('岗位发现未做个人匹配；补画像并 prepare 新匹配运行后才能评估或导出匹配Excel');
  if(run.search_plan){validateSearchPlan(run.search_plan,sources);if(run.search_plan_fingerprint!==searchPlanFingerprint(run.search_plan))throw Error('检索计划已改变，请重新 prepare；不能沿用旧快照');}
 }
 if(flags.run&&['next-batch','plan-assessment','batch-create','batch-start','batch-submit','batch-merge','render'].includes(command))await syncRoleReviews(path.resolve(String(flags.run)),{requireComplete:true});
 if(flags.run&&['next-batch','plan-assessment','screening-summary','batch-create','batch-start','batch-submit','batch-merge','render'].includes(command)){
  const dir=workspacePath(path.resolve(String(flags.run))),run=await readJson(path.join(dir,'run.json'));
  for(const c of run.companies.filter(c=>c.selected)){
   const current=sources.find(s=>s.company_id===c.company_id),snapshot=await readJson(path.join(dir,'companies',c.company_id+'.json'),null);
   if((SEARCH_MODE.id!=='campus'||run.search_plan||snapshot?.search_plan_fingerprint)&&(!current||snapshot&&!sourceCacheMatches(snapshot,current,run.search_plan)))throw Error('历史运行快照与当前来源配置不一致，请重新 prepare/collect：'+c.display_name);
  }
 }
 if(command==='industries'){console.log(JSON.stringify({industries:INDUSTRIES.map(x=>({...x,companies:sources.filter(c=>c.industry_tags?.includes(x.id)).length})),all_companies:sources.length,source_validation:{...registryGate,companies:undefined},multiple_selection:true}));return;}
 if(command==='catalog')return catalog();
 if(command==='render-discovery'){
  if(!flags.run)throw Error('需要 --run');
  const {renderDiscovery}=await import('./discovery-report.mjs');
  console.log(JSON.stringify(await renderDiscovery(path.resolve(String(flags.run)))));return;
 }

 if(command==='search-plan-check'){if(!flags.file)throw Error('需要 --file');const plan=validateSearchPlan(await readJson(path.resolve(String(flags.file))),sources);console.log(JSON.stringify({valid:true,companies:plan.company_ids.length,keywords:plan.keywords,fingerprint:searchPlanFingerprint(plan)}));return;}
 if(!command||command==='help')console.log(BATCH_HELP);
 if(['batch-create','batch-start','batch-submit','batch-merge','batch-close','batch-status'].includes(command)){
  if(!flags.run)throw new Error('需要 --run');
  const dir=workspacePath(path.resolve(String(flags.run))),api=await import('../../shared/job-search-core/scripts/lib/batches.mjs');let result;
  if(command==='batch-create')result=await api.createBatch(dir,{limit:integer('limit',50,100),maxChars:integer('max-chars',160000,2000000),concurrency:integer('concurrency',4,8),keys:flags.jobs?await readJson(workspacePath(path.resolve(String(flags.jobs)))):undefined});
  if(command==='batch-start')result=await api.startBatch(dir,String(flags.batch||''),flags.agent,{toolStartedAt:flags['tool-started-at'],toolFinishedAt:flags['tool-finished-at']});
  if(command==='batch-submit'){
   if(!flags.file)throw new Error('需要 --file');const submission=await readJson(workspacePath(path.resolve(String(flags.file))));
   result=await api.submitBatch(dir,String(flags.batch||''),flags.agent,submission.items);
  }
  if(command==='batch-merge')result=await api.mergeBatch(dir,String(flags.batch||''));
  if(command==='batch-close')result=await api.closeBatch(dir,String(flags.batch||''),{agentId:flags.agent,stopped:flags.stopped===true,usageLog:flags['usage-log']?path.resolve(String(flags['usage-log'])):undefined,toolStartedAt:flags['tool-started-at'],toolFinishedAt:flags['tool-finished-at']});
  if(command==='batch-status')result=await api.batchStatus(dir,{refresh:flags.refresh===true});
  console.log(JSON.stringify(result));if(result?.errors&&Object.keys(result.errors).length)process.exitCode=2;return;
 }
 if(command==='prepare')return prepare();if(command==='collect')return collectRun();if(command==='next-batch')return nextBatch();
 if(command==='plan-assessment'){
  if(!flags.run)throw new Error('需要 --run');
  const dir=workspacePath(path.resolve(String(flags.run))),run=await readJson(path.join(dir,'run.json'));
  const batchState=await readJson(path.join(dir,'parallel/batches/state.json'),null);if(batchState?.batches.some(b=>!b.closed_at))throw new Error('仍有未关闭的固定批次；请先回收执行者再修改范围');
  const task=flags.task?await readJson(path.resolve(String(flags.task))):run.task_snapshot;
  const jobs=flags.jobs?await readJson(path.resolve(String(flags.jobs))):undefined;
  if(task){
   assertTaskExecution(task,run.profile,SEARCH_MODE.id,{searchPlan:run.search_plan||null});
   if(run.task_snapshot)assertScopeRevision(run.task_snapshot,task);
   flags.mode??=task.evaluation_scope?.value?.mode;flags.limit??=task.evaluation_scope?.value?.limit;
   flags.only??=task.evaluation_scope?.value?.companies?.join(',');flags['user-request']??=task.evaluation_scope?.basis;
   const companyIds=flags.only?String(flags.only).split(',').map(value=>{const id=value.trim();return sources.find(s=>s.company_id===id||s.display_name===id)?.company_id||id;}):[];
   const candidateCount=flags.mode==='sample'&&Array.isArray(jobs)?(await screeningSummary(dir)).candidates.filter(job=>!companyIds.length||companyIds.includes(job.company_id)).length:undefined;
   assertTaskScope(task,{mode:flags.mode,limit:flags.limit,companyIds,jobs,candidateCount});
  }
  const scope=await planAssessment(dir,{mode:flags.mode,only:flags.only,limit:flags.limit,jobs,userRequest:flags['user-request']});
  if(task){
   const updated=await readJson(path.join(dir,'run.json'));
   if(updated.task_snapshot&&updated.task_fingerprint!==taskFingerprint(task))updated.task_history=[...(updated.task_history||[]),updated.task_snapshot];
   updated.task_snapshot=task;updated.task_fingerprint=taskFingerprint(task);await writeJson(path.join(dir,'run.json'),updated);
  }
  console.log(JSON.stringify(scope));return;
 }
 if(command==='screening-summary'){
  if(!flags.run)throw new Error('需要 --run');console.log(JSON.stringify(await screeningSummary(path.resolve(String(flags.run)))));return;
 }
 if(command==='render'){const {renderRun}=await import('../../shared/job-search-core/scripts/lib/reports.mjs');return renderRun(workspacePath(path.resolve(String(flags.run||''))),{allowPartial:flags['allow-partial']===true,previewDir:flags['preview-dir']?path.resolve(String(flags['preview-dir'])):undefined});}
 if(command==='status'){const tags=(companyContext.cities[SEARCH_MODE.id]||{companies:[]});const biz=companyContext.business,ownership=companyContext.ownership;const ownershipProblems=ownershipDatasetProblems(sources,ownership);const confirmedUnresolved=ownership.companies.filter(c=>c.status==='verified_unresolved'&&c.ownership_tag==='待核实'&&!ownershipProblems.some(p=>p.company_id===c.company_id)).length;const ownershipOrigins=new Map(companyContext.records.companies.map(r=>[r.company_id,r.governance.fields['tags.ownership'].origin]));console.log(JSON.stringify({sources:sources.length,cities:tags.companies.length,with_cities:tags.companies.filter(c=>c.cities.length).length,business_labels:biz.companies.length,ownership_labels:ownership.companies.length,ownership_decided:sources.length-ownershipProblems.length-confirmedUnresolved,ownership_api_supported:ownership.companies.filter(c=>c.status==='api_supported').length,ownership_verified:ownership.companies.filter(c=>c.status==='verified').length,ownership_fresh_verified:ownership.companies.filter(c=>c.status==='verified'&&ownershipOrigins.get(c.company_id)==='fresh_web_review').length,ownership_legacy_verified:ownership.companies.filter(c=>c.status==='verified'&&ownershipOrigins.get(c.company_id)==='legacy_import').length,ownership_confirmed_unresolved:confirmedUnresolved,ownership_incomplete:ownershipProblems.length,ownership_ready:ownershipProblems.length===0}));return;}
 console.log('campus.mjs industries\ncampus.mjs catalog --industries 行业[,行业] [--cities 城市[,城市]] [--only 公司名,公司名] [--out 文件]\ncampus.mjs catalog --profile profile.json\ncampus.mjs prepare --profile profile.json [--out 运行目录]\ncampus.mjs collect --run 运行目录 [--refresh]\ncampus.mjs screening-summary --run 运行目录\ncampus.mjs plan-assessment --run 运行目录 --mode sample|companies|all --user-request 用户明确需求 [--limit 实验数量] [--only 公司名,公司名] [--jobs 岗位键JSON]\ncampus.mjs next-batch --run 运行目录 [--limit 20]\ncampus.mjs render --run 运行目录 [--allow-partial]\ncampus.mjs status');
}
await main();
