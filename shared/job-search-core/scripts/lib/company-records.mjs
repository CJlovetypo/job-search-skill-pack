import {ARCHIVE_FILE,REVIEWS_FILE,API_LABELS_FILE,DEMO_LABELS_FILE,INTERNAL_RECORDS_FILE,RESEARCH_ROOT,RAW_ROOT,resolveResearchRecord} from '../../maintenance-paths.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {CORE_ROOT,PACK_ROOT, MODE_ROOTS} from '../../runtime-context.mjs';
import {INDUSTRIES} from './industry-routing.mjs';
import {businessVocabulary} from './business-taxonomy.mjs';
import {classifyCompanySize} from './company-size.mjs';
import {scoreAssessment} from './company-review-policy.mjs';

export const RECORD_VERSION = 1;
export const REVIEW_FILE = REVIEWS_FILE;
export const STATIC_FIELDS = Object.freeze([
  'tags.industry', 'tags.business', 'tags.ownership', 'tags.headquarters_country', 'tags.listing_status',
  'descriptions.business_summary', 'descriptions.products_services', 'descriptions.customers',
  'descriptions.business_regions', 'descriptions.workforce', 'descriptions.capital', 'descriptions.entity_relationships',
]);
export const MODES = Object.keys(MODE_ROOTS);
const read = async (p, fallback) => {try {return JSON.parse(await fs.readFile(p, 'utf8'));} catch (e) {if(e.code==='ENOENT' && fallback!==undefined)return fallback;throw e;}};
const text = v => typeof v === 'string' && v.trim().length > 0;
const date = v => text(v) && Number.isFinite(Date.parse(v));
const http = v => {try{return ['http:', 'https:'].includes(new URL(v).protocol);}catch{return false;}};
export const contentHash = v => createHash('sha256').update(v).digest('hex');
export function indexById(dataset) {
  const map = new Map();
  for (const row of dataset?.companies || []) {
    if (!text(row.company_id) || map.has(row.company_id)) throw Error('缺失或重复公司ID：'+row.company_id);
    map.set(row.company_id, row);
  }
  return map;
}
const get = (row, key) => key.split('.').reduce((r,k)=>r?.[k], row);
const set = (row, key, value) => {const keys=key.split('.'),last=keys.pop();let at=row;for(const k of keys)at=at[k]??={};at[last]=value;};
const metadata = (row={}, overrides={}) => ({status:row.status||'unknown',reason:row.reason||'',entity:row.entity||'',as_of:row.as_of||'',checked_at:row.checked_at||null,evidence:row.evidence||[],origin:'legacy_import',review_state:'pending',...overrides});

// This queue deliberately contains identity anchors only. Old labels never become prompts or proof.
export function researchQueue(registry, {campaignId, startedAt=new Date().toISOString(), vocabulary=[], reuseEvidence=false}={}) {
  indexById(registry);
  if(!text(campaignId) || !date(startedAt))throw Error('复核批次需要ID和开始时间');
  return {schema_version:reuseEvidence?2:1,campaign_id:campaignId,started_at:startedAt,...(reuseEvidence?{evidence_policy:'archived_body',include_recruitment:false}:{}),
    vocabulary:[...new Set(vocabulary)].sort(),required_fields:STATIC_FIELDS,
    companies:registry.companies.map(c=>({company_id:c.company_id,display_name:c.display_name,aliases:c.aliases||[],
      recruitment_urls:[...new Set([c.primary_entry_url,...(c.recruitment_sources||[]).map(s=>s.primary_entry_url)].filter(http))],
      state:'pending'}))};
}

export function validateReview(review, campaign, {now=new Date().toISOString()}={}) {
  const fail = message => {throw Error(message);};
  if(review.campaign_id!==campaign.campaign_id || !campaign.companies.some(c=>c.company_id===review.company_id))fail('复核批次或主体ID不一致');
  const fresh = t => date(t) && Date.parse(t)>=Date.parse(campaign.started_at) && Date.parse(t)<=Date.parse(now)+60000;
  const reusable=campaign.schema_version===2&&campaign.evidence_policy==='archived_body';
  const evidenceTime=t=>date(t)&&Date.parse(t)<=Date.parse(now)+60000;
  if(reusable&&!fresh(review.reviewed_at))fail('缺少本次实际审核时间');
  if(!Array.isArray(review.searches)||(!reusable&&!review.searches.length))fail('每家公司必须有本轮实际搜索记录');
  for(const s of review.searches)if(!text(s.query)||!text(s.tool)||!(reusable?evidenceTime:fresh)(s.searched_at)||!['success','failed'].includes(s.status)||!Array.isArray(s.result_urls)||s.result_urls.some(u=>!http(u))||(s.status==='failed'&&!text(s.error)))fail('搜索记录缺失、过期或无效');
  if(!text(review.identity_reason))fail('缺少本轮主体关联说明');
  const docs=new Map();
  for(const d of review.documents||[]) {
    if(!text(d.id)||docs.has(d.id)||!http(d.url)||!text(d.title)||!text(d.content)||!text(d.entity)||!text(d.identity_basis)||!(reusable?evidenceTime:fresh)(d.fetched_at)||!text(d.tool)||d.read_kind!=='page_body'||d.sha256!==contentHash(d.content))fail('正文证据缺失、摘要冒充正文、过期或哈希不一致');
    if(reusable&&(!text(d.raw_archive)||!/^[a-f0-9]{64}$/.test(d.raw_sha256||'')||!text(d.applicability_reason)))fail('复用正文需要原件、哈希及本次适用性说明');
    docs.set(d.id,d);
  }
  const entries=Object.entries(review.decisions||{});
  if(!entries.length)fail('缺少逐字段结论');
  for(const [key,d] of entries) {
    if(!STATIC_FIELDS.includes(key))fail('未发布字段：'+key);
    const scope=campaign.companies.find(c=>c.company_id===review.company_id)?.requested_fields||campaign.required_fields||STATIC_FIELDS;
    if(!scope.includes(key))fail('字段不在本次范围：'+key);
    if(d.campaign_id!==undefined && d.campaign_id!==review.campaign_id)fail('新提交字段批次不一致：'+key);
    if(!['verified','unresolved'].includes(d.status)||!text(d.reason)||!text(d.entity)||!fresh(d.checked_at))fail('字段结论缺少状态、理由、主体或本轮时间：'+key);
    if(d.status==='verified' && (!Array.isArray(d.citations)||!d.citations.length))fail('已核实结论必须引用本轮正文：'+key);
    if(d.status==='unresolved' && d.value!==null)fail('未决值必须为null：'+key);
    for(const c of d.citations||[])if(!docs.has(c.document_id)||!text(c.excerpt)||!docs.get(c.document_id).content.includes(c.excerpt))fail('引用必须来自本公司本轮已保存正文：'+key);
    if(d.status==='unresolved') {
      if(d.investigation?.completed===true&&(!text(d.investigation.reason)||!text(d.investigation.resume_when)||!d.investigation.evidence_ids?.length||d.investigation.evidence_ids.some(id=>!docs.has(id))))fail('调查暂结需要真实正文范围、未决原因和恢复条件：'+key);
      continue;
    }
    if(['tags.industry','tags.business'].includes(key)) {
      const allowed=new Set(key==='tags.industry'?INDUSTRIES.map(i=>i.id):campaign.vocabulary);
      if(!Array.isArray(d.value)||!d.value.length||new Set(d.value).size!==d.value.length||d.value.some(v=>!allowed.has(v)))fail('标签超出现有词表或为空：'+key);
    } else if(key==='tags.ownership') {
      if(!['国企','私企','外企'].includes(d.value))fail('性质超出既有枚举');
    } else if(key==='tags.listing_status') {
      if(!['已上市','未上市'].includes(d.value))fail('上市状态无效');
    } else if(!text(d.value))fail('已核实描述或国家字段不能为空：'+key);
  }
  return true;
}

// Publication merges decisions; original capture dates survive an archived-evidence review.
export function mergePublishedReview(previous, incoming) {
  if(!previous)return {...structuredClone(incoming),decisions:Object.fromEntries(Object.entries(incoming.decisions).map(([key,d])=>[key,{...structuredClone(d),campaign_id:incoming.campaign_id}]))};
  if(previous.company_id!==incoming.company_id)throw Error('不能合并不同主体的复核记录');
  const old=structuredClone(previous),next=structuredClone(incoming);
  const decisions=Object.fromEntries(Object.entries(old.decisions).map(([key,d])=>[key,{...d,campaign_id:d.campaign_id||old.campaign_id}]));
  const documents=new Map((old.documents||[]).map(d=>[d.id,d]));
  const remap=new Map();
  for(const doc of next.documents||[]) {
    let id=doc.id;
    if(documents.has(id)&&JSON.stringify(documents.get(id))!==JSON.stringify(doc)) {
      id=doc.id+'-'+contentHash(next.campaign_id+'\n'+JSON.stringify(doc)).slice(0,24);
      if(documents.has(id)&&JSON.stringify(documents.get(id))!==JSON.stringify({...doc,id}))throw Error('发布证据ID冲突');
    }
    remap.set(doc.id,id);documents.set(id,{...doc,id});
  }
  for(const [key,d] of Object.entries(next.decisions)) {
    const prior=decisions[key];
    if(prior&&(!date(prior.checked_at)||Date.parse(prior.checked_at)>Date.parse(d.checked_at)))throw Error('存在更新或时间不明的字段结论，拒绝覆盖：'+key);
    const decision={...d,campaign_id:next.campaign_id,citations:(d.citations||[]).map(c=>({...c,document_id:remap.get(c.document_id)||c.document_id}))};
    if(prior&&prior.checked_at===decision.checked_at&&JSON.stringify(prior)!==JSON.stringify(decision))throw Error('同一时间字段存在不同结论，拒绝覆盖：'+key);
    decisions[key]=decision;
  }
  const searches=[...new Map([...(old.searches||[]),...(next.searches||[])].map(s=>[JSON.stringify(s),s])).values()];
  return {...old,...next,...(old.field_assessments||next.field_assessments?{field_assessments:{...old.field_assessments,...next.field_assessments}}:{}),searches,documents:[...documents.values()],decisions};
}

function reviewedMetadata(d, review) {
  const docs=new Map(review.documents.map(x=>[x.id,x]));
  return {status:d.status,reason:d.reason,entity:d.entity,as_of:d.as_of||'',checked_at:d.checked_at,
    evidence:(d.citations||[]).map(c=>{const doc=docs.get(c.document_id);return {url:doc.url,title:doc.title,note:c.excerpt,evidence_type:doc.evidence_type||'official_website',checked_at:doc.fetched_at,document_id:doc.id,sha256:doc.sha256};}),
    origin:'fresh_web_review',review_state:d.status==='verified'?'reviewed':'reviewed_unresolved',campaign_id:d.campaign_id||review.campaign_id};
}

function apiMetadata(d) {
  return {status:'api_supported',reason:d.reason,entity:d.entity,as_of:d.as_of||'',checked_at:d.checked_at,
    evidence:d.evidence||[],provider:d.provider,providers:d.alternative_providers||[d.provider],source_record:d.source_record,source_urls:d.source_urls||[],
    origin:'api_search',review_state:'api_supported_unverified'};
}
function demoMetadata(d) {
  return {status:'demo_unreviewed',reason:d.reason,entity:d.entity,as_of:d.as_of||'',checked_at:d.checked_at,
    evidence:d.evidence||[],provider:d.provider||'archived_search',providers:d.providers||[d.provider||'archived_search'],source_record:d.source_record||'',source_urls:d.source_urls||[],
    origin:d.method==='local_description_classification'?'local_description_classification':'demo_search',review_state:'demo_unreviewed',demo_batch:d.demo_batch,data_availability:d.data_availability||'candidate_value',
    ...(d.method==='local_description_classification'?{model_version:d.taxonomy_version,dependencies:['descriptions.business_summary','descriptions.products_services']}: {})};
}
function validApiDecision(key,d,vocabulary) {
  if(!STATIC_FIELDS.includes(key)||d?.status!=='api_supported'||!text(d.entity)||!date(d.checked_at)||!text(d.provider)||!text(d.source_record)||!text(d.reason))return false;
  if(!Array.isArray(d.evidence)||!d.evidence.length||d.evidence.some(e=>!http(e.url)||!text(e.title)||!text(e.note)))return false;
  if(['tags.industry','tags.business'].includes(key)) {
    const allowed=key==='tags.industry'?new Set(INDUSTRIES.map(i=>i.id)):vocabulary;
    return Array.isArray(d.value)&&d.value.length>0&&new Set(d.value).size===d.value.length&&d.value.every(v=>allowed.has(v));
  }
  if(key==='tags.ownership')return ['国企','私企','外企'].includes(d.value);
  if(key==='tags.listing_status')return ['已上市','未上市'].includes(d.value);
  return text(d.value);
}
function validDemoDecision(key,d,vocabulary) {
  if(!STATIC_FIELDS.includes(key)||d?.status!=='demo_unreviewed'||!text(d.entity)||!date(d.checked_at)||!text(d.reason)||!text(d.demo_batch))return false;
  if(!Array.isArray(d.evidence)||d.evidence.some(e=>!http(e.url)||!text(e.title)||!text(e.note)))return false;
  if(['tags.industry','tags.business'].includes(key)) {
    const allowed=key==='tags.industry'?new Set(INDUSTRIES.map(i=>i.id)):new Set([...vocabulary,'待核实']);
    return Array.isArray(d.value)&&d.value.length>0&&new Set(d.value).size===d.value.length&&d.value.every(v=>allowed.has(v));
  }
  if(key==='tags.ownership')return ['国企','私企','外企','待核实'].includes(d.value);
  if(key==='tags.listing_status')return ['已上市','未上市','待核实'].includes(d.value);
  return text(d.value);
}

export function buildCompanyRecords({registry,business,ownership,profiles,size,cities={},reviews={companies:[]},research={companies:[]},apiLabels={companies:[]},demoLabels={companies:[]}}, {now=new Date().toISOString()}={}) {
  const sources=indexById(registry),biz=indexById(business),own=indexById(ownership),prof=indexById(profiles),sizes=indexById(size),rev=indexById(reviews),candidate=indexById(research),api=indexById(apiLabels),demo=indexById(demoLabels);
  const vocabulary=new Set([...businessVocabulary(),...business.companies.flatMap(c=>c.business_tags||[])]);
  const cityMaps=Object.fromEntries(MODES.map(m=>[m,indexById(cities[m])]));
  for(const [name,map] of Object.entries({business:biz,ownership:own,profiles:prof,size:sizes,reviews:rev,research:candidate,apiLabels:api,demoLabels:demo,...cityMaps}))for(const id of map.keys())if(!sources.has(id))throw Error(name+'包含未知公司：'+id);
  const companies=registry.companies.map(c=>{
    const b=biz.get(c.company_id)||{},o=own.get(c.company_id)||{},p=prof.get(c.company_id)||{},r=rev.get(c.company_id);
    const row={company_id:c.company_id,identity:{company_id:c.company_id,display_name:c.display_name,aliases:c.aliases||[]},
      tags:{industry:c.industry_tags||[],business:b.business_tags||[],ownership:o.ownership_tag||'待核实',organization_size:sizes.get(c.company_id)?.label||'待核实',headquarters_country:null,listing_status:null,recruitment:{}},
      descriptions:{business_summary:b.business_summary||p.business?.value||'',products_services:'',customers:'',business_regions:'',workforce:p.workforce?.value||'',capital:p.capital?.value||'',entity_relationships:''},
      sources:(c.recruitment_sources?.length?c.recruitment_sources:[c]).map(s=>({source_id:s.source_id||null,provider:s.provider||null,url:s.primary_entry_url||null,verification:s.source_verification||null})),
      governance:{fields:{},recruitment:{}},research_candidates:candidate.has(c.company_id)?{
        review_state:candidate.get(c.company_id).review_state,proposals:candidate.get(c.company_id).proposals,
        archived_field_count:Object.values(candidate.get(c.company_id).fields||{}).reduce((n,items)=>n+items.length,0),
        supplemental_record_count:(candidate.get(c.company_id).supplemental_research||[]).length,
        archive_file:'datasets/company-research/candidates/company-research-candidates.json.gz',company_id:c.company_id}:null};
    const g=row.governance.fields;
    for(const key of STATIC_FIELDS)g[key]=metadata();
    g['tags.industry']=metadata(c.industry_assignment||c.industry_tag_basis||{});
    g['tags.business']=metadata(b,{checked_at:b.evidence?.[0]?.checked_at||null});
    g['descriptions.business_summary']=metadata(b,{checked_at:b.evidence?.[0]?.checked_at||null});
    g['tags.ownership']=metadata(o);
    for(const k of ['workforce','capital'])g['descriptions.'+k]=metadata(p[k]);
    for(const mode of MODES) {
      const entry=cityMaps[mode].get(c.company_id)||{};
      row.tags.recruitment[mode]={cities:entry.cities||[]};
      row.governance.recruitment[mode]={...structuredClone(entry),company_id:undefined,display_name:undefined,cities:undefined,origin:'official_job_observation',review_state:'pending'};
    }
    for(const [key,decision] of Object.entries(api.get(c.company_id)?.decisions||{})) {
      if(!validApiDecision(key,decision,vocabulary))throw Error('API标签包含无效字段、证据或状态：'+key);
      set(row,key,decision.value);g[key]=apiMetadata(decision);
    }
    if(r)for(const [key,decision] of Object.entries(r.decisions)) {
      if(!STATIC_FIELDS.includes(key))throw Error('复核记录包含未知字段：'+key);
      set(row,key,decision.value);g[key]=reviewedMetadata(decision,r);
    }
    for(const [key,decision] of Object.entries(demo.get(c.company_id)?.decisions||{})) {
      if(g[key].status==='verified'&&g[key].origin==='fresh_web_review')continue;
      if(!validDemoDecision(key,decision,vocabulary))throw Error('Demo标签包含无效字段、证据或状态：'+c.company_id+' '+key);
      set(row,key,decision.value);g[key]=demoMetadata(decision);
    }
    // Size is derived using the existing model; never retain a stale ownership input.
    deriveOrganizationSize(row,{now,sizeEligible:r?.field_assessments?.['descriptions.workforce']?.size_eligible!==false});
    return row;
  });
  return {schema_version:RECORD_VERSION,generated_at:now,companies};
}

export function deriveOrganizationSize(row,{now=new Date().toISOString(),sizeEligible=true}={}) {
  const g=row.governance.fields,workforceMeta=g['descriptions.workforce'];
  const workforce={value:row.descriptions.workforce||'',...workforceMeta};
  const sizeRow=classifyCompanySize({company_id:row.company_id,display_name:row.identity.display_name},{ownership_tag:row.tags.ownership,status:g['tags.ownership'].status},{workforce},{now});
  row.tags.organization_size=sizeEligible?sizeRow.label:'待核实';
  g['tags.organization_size']={...metadata(sizeRow),origin:'derived_existing_model',model_version:sizeRow.model_version,dependencies:['tags.ownership','descriptions.workforce'],review_state:g['tags.ownership'].origin==='fresh_web_review'&&workforceMeta.origin==='fresh_web_review'?'reviewed':'pending'};
  if(!sizeEligible)Object.assign(g['tags.organization_size'],{status:'unknown',reason:'已核实人数描述的范围不支持现有组织规模派生。'});
  return row;
}

// Compatibility projection lets the established search/report logic consume the same field decisions.
export function projectCompanyRecords(records, inputs) {
  const result={...inputs,registry:{...inputs.registry,companies:inputs.registry.companies.map(c=>({...c}))},
    business:{...inputs.business},ownership:{...inputs.ownership},profiles:{...inputs.profiles}},byId=indexById(records);
  const published=(r,key)=>['fresh_web_review','api_search','demo_search'].includes(r.governance.fields[key]?.origin);
  const b=indexById(result.business),o=indexById(result.ownership),p=indexById(result.profiles);
  for(const source of result.registry.companies) {
    const r=byId.get(source.company_id),g=r.governance.fields,base={company_id:source.company_id,display_name:source.display_name};
    if(published(r,'tags.industry')&&r.tags.industry?.length)source.industry_tags=r.tags.industry;
    if(published(r,'tags.business')||published(r,'descriptions.business_summary')) {
      const old=b.get(source.company_id)||base;
      b.set(source.company_id,{...old,...base,business_tags:r.tags.business||[],business_summary:r.descriptions.business_summary||'',status:g['tags.business'].status==='unresolved'?'unknown':g['tags.business'].status,evidence:g['tags.business'].evidence});
    }
    if(published(r,'tags.ownership'))o.set(source.company_id,{...base,ownership_tag:r.tags.ownership||'待核实',status:g['tags.ownership'].status==='unresolved'?'verified_unresolved':g['tags.ownership'].status,reason:g['tags.ownership'].reason,checked_at:g['tags.ownership'].checked_at,evidence:g['tags.ownership'].evidence,provider:g['tags.ownership'].provider||null,origin:g['tags.ownership'].origin,review_state:g['tags.ownership'].review_state});
    const profile={...(p.get(source.company_id)||base)};
    for(const [old,key] of [['business','descriptions.business_summary'],['workforce','descriptions.workforce'],['capital','descriptions.capital']])if(published(r,key))profile[old]={value:get(r,key)||'',status:g[key].status==='verified'?'verified':g[key].status==='api_supported'?'api_supported':'demo_unreviewed',entity:g[key].entity,as_of:g[key].as_of,checked_at:g[key].checked_at,evidence:g[key].evidence||[],review_reason:g[key].reason};
    p.set(source.company_id,profile);
  }
  result.business.companies=[...b.values()];result.ownership.companies=[...o.values()];result.profiles.companies=[...p.values()];
  result.size={schema_version:1,companies:records.companies.map(r=>({company_id:r.company_id,display_name:r.identity.display_name,label:r.tags.organization_size,...r.governance.fields['tags.organization_size']}))};
  return result;
}

export async function loadCompanyInputs({includeResearch=false,includePrivate=true}={}) {
  const filenames={registry:'assets/sources.json',business:'data/company-business-tags.json',ownership:'data/company-ownership-tags.json',profiles:'data/company-profiles.json',size:'data/company-size-tags.json',reviews:'data/company-label-reviews.json'};
  const data=Object.fromEntries(await Promise.all(Object.entries(filenames).map(async([key,file])=>{
    if(key==='reviews')return [key,includePrivate?await read(REVIEWS_FILE,{companies:[]}):{companies:[]}];
    const published=await read(path.join(CORE_ROOT,file),{companies:[]});
    return [key,includePrivate&&['business','ownership','profiles','size'].includes(key)?await read(path.join(RESEARCH_ROOT,'inputs',path.basename(file)),published):published];
  })));
  if(includePrivate)try {data.apiLabels=JSON.parse(gunzipSync(await fs.readFile(API_LABELS_FILE)).toString('utf8'));}
  catch(error) {if(error.code==='ENOENT')data.apiLabels={companies:[]};else throw error;}
  if(includePrivate)try {data.demoLabels=JSON.parse(gunzipSync(await fs.readFile(DEMO_LABELS_FILE)).toString('utf8'));}
  catch(error) {if(error.code==='ENOENT')data.demoLabels={companies:[]};else throw error;}
  if(includeResearch&&includePrivate) {
    try {data.research=JSON.parse(gunzipSync(await fs.readFile(ARCHIVE_FILE)).toString('utf8'));}
    catch(error) {if(error.code==='ENOENT')data.research={companies:[]};else throw error;}
  }
  data.cities=Object.fromEntries(await Promise.all(Object.entries(MODE_ROOTS).map(async([mode,root])=>[mode,await read(path.join(PACK_ROOT,root,'data/company-city-index.json'),{companies:[]})])));
  return data;
}
export async function loadCompanyContext() {
  const inputs=await loadCompanyInputs({includePrivate:false});
  const records=await read(path.join(CORE_ROOT,'data/company-records.json'),null)||buildCompanyRecords(inputs);
  // Cities are maintained through their own public API index; static publication must not freeze them.
  for(const mode of MODES){const cities=indexById(inputs.cities[mode]);for(const row of records.companies){const city=cities.get(row.company_id);if(city){row.tags.recruitment[mode]={cities:city.cities||[]};row.governance.recruitment[mode]={origin:'official_job_observation',updated_at:city.updated_at||null,last_refresh_at:city.last_refresh_at||null,last_refresh_status:city.last_refresh_status||null,city_coverage_complete:city.city_coverage_complete||false};}}}
  return {...projectCompanyRecords(records,inputs),records};
}

export function campaignProgress(campaign, reviews, cities={}) {
  const byId=indexById(reviews),cityMaps=Object.fromEntries(MODES.map(m=>[m,indexById(cities[m])]));
  const companies=campaign.companies.map(c=>{
    const r=byId.get(c.company_id),same=r?.campaign_id===campaign.campaign_id;
    const searched=same&&r.searches?.some(s=>s.status==='success'&&Date.parse(s.searched_at)>=Date.parse(campaign.started_at));
    const scope=c.requested_fields||campaign.required_fields||STATIC_FIELDS;
    const reviewed=same?scope.filter(f=>r.decisions[f]&&(r.decisions[f].campaign_id||r.campaign_id)===campaign.campaign_id):[];
    const completed=reviewed.filter(f=>{const d=r.decisions[f];return d.status==='verified'?(campaign.schema_version===2?scoreAssessment(f,r.field_assessments?.[f],{decision:d,documentIds:(d.citations||[]).map(c=>c.document_id)}).eligible:d.citations?.length>0):d.investigation?.completed===true&&text(d.investigation.reason)&&d.investigation.evidence_ids?.length>0&&text(d.investigation.resume_when);});
    const cityState=Object.fromEntries(MODES.map(mode=>{const e=cityMaps[mode].get(c.company_id);return [mode,date(e?.last_refresh_at)&&Date.parse(e.last_refresh_at)>=Date.parse(campaign.started_at)?e.last_refresh_status||'unknown':'pending'];}));
    return {...c,searched:!!searched,reviewed_fields:reviewed.length,completed_fields:completed.length,static_complete:scope.length>0&&completed.length===scope.length,city_state:cityState,
      unresolved_fields:same?reviewed.filter(k=>r.decisions[k].status==='unresolved'):[]};
  });
  return {campaign_id:campaign.campaign_id,total:companies.length,searched:companies.filter(c=>c.searched).length,
    static_complete:companies.filter(c=>c.static_complete).length,fully_reviewed:companies.filter(c=>c.static_complete&&(campaign.include_recruitment===false||Object.values(c.city_state).every(v=>v!=='pending'))).length,
    untouched:companies.filter(c=>!c.searched&&!c.reviewed_fields).length,companies};
}
