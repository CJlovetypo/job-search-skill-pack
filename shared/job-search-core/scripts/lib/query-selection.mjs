import {createHash} from 'node:crypto';
import {normalizeIndustries,industryMatches} from './industry-routing.mjs';
import {normalizeBusinessFilters,businessMatchMode,businessMatches} from './business-taxonomy.mjs';
import {normalizeCityFilters,companyCityMatches} from './locations.mjs';
import {ownershipDisplayTag} from './ownership.mjs';

export const QUERY_VERSION=1;
const strings=(v,name)=>{if(v==null)return [];if(!Array.isArray(v)||v.some(x=>typeof x!=='string'||!x.trim()))throw Error(name+' 必须为字符串数组');return [...new Set(v.map(x=>x.trim()))];};
export function normalizeQuery(raw={}){
  const cityPreference=raw.city_preference;
  const q={schema_version:QUERY_VERSION,mode:raw.mode,
    industry_filters:normalizeIndustries(raw.industry_filters||['all']),
    company_filters:strings(raw.company_filters,'公司'),business_filters:normalizeBusinessFilters(raw.business_filters),business_filter_match:businessMatchMode(raw.business_filter_match),
    ownership_filters:strings(raw.ownership_filters,'公司性质'),headquarters_country_filters:strings(raw.headquarters_country_filters,'总部国家'),listing_status_filters:strings(raw.listing_status_filters,'上市状态'),
    city_filters:normalizeCityFilters(['prefer','open'].includes(cityPreference?.importance)?[]:raw.city_filters||[]),city_preference:cityPreference||{state:(raw.city_filters||[]).length?'explicit':'unspecified',values:raw.city_filters||[],importance:(raw.city_filters||[]).length?'must':'open'},
    roles:strings(raw.roles,'岗位目标'),exclude_keywords:strings(raw.exclude_keywords,'排除词'),retrieval:raw.retrieval||{mode:'exhaustive',selection:'default',basis:'无岗位目标时使用全量'},scope_basis:raw.scope_basis||null};
  if(!['campus','internship','social'].includes(q.mode))throw Error('需要明确招聘方向');
  if(q.ownership_filters.some(x=>!['国企','私企','外企'].includes(x)))throw Error('公司性质筛选只接受国企、私企、外企');
  if(!['must','prefer','open'].includes(q.city_preference.importance))throw Error('城市偏好权重无效');
  return q;
}
export function retrievalIssues({roles=[],retrieval={},scopeKnown=true}){
  const issues=[];
  if(!scopeKnown)issues.push({field:'industries',question:'请明确行业、业务或公司范围，也可以明确不限行业。'});
  if(!['targeted','exhaustive'].includes(retrieval.mode)||!['explicit','inherited','default'].includes(retrieval.selection)||typeof retrieval.basis!=='string'||!retrieval.basis.trim())issues.push({field:'retrieval',question:'请记录真实的搜索方式选择及依据。'});
  else if((roles.length||retrieval.mode==='targeted')&&!['explicit','inherited'].includes(retrieval.selection))issues.push({field:'retrieval',question:'请选择标题定向搜索（通常更快，可能漏掉不同标题的相关岗位），或全量 JD 综合判断（覆盖更充分，耗时较长）。'});
  return issues;
}
export function assertQueryReady(query){
  const issues=retrievalIssues({...query,scopeKnown:!!(query.scope_basis||query.company_filters.length||query.business_filters.length||!query.industry_filters.includes('all'))});
  if(issues.length)throw Error(issues.map(i=>i.question).join('；'));
  return query;
}
export function queryFingerprint(query){return createHash('sha256').update(JSON.stringify(query)).digest('hex');}
export function selectQueryCompanies(context,raw,{applyCities=true,plan=null}={}){
  const query=normalizeQuery(raw),companies=context.registry.companies;
  const records=new Map((context.records?.companies||[]).map(x=>[x.company_id,x]));
  const business=new Map((context.business?.companies||[]).map(x=>[x.company_id,x]));
  const owners=new Map((context.ownership?.companies||[]).map(x=>[x.company_id,x]));
  const cityIndex=context.cities?.[query.mode];
  if(applyCities&&query.city_filters.length&&(!cityIndex||!Array.isArray(cityIndex.companies)||cityIndex.unavailable))throw Error('正式城市索引不可用，不能将缺失索引解释为零家公司');
  const cities=new Map((cityIndex?.companies||[]).map(x=>[x.company_id,x]));
  const requested=new Set();
  for(const name of query.company_filters){const entity=[...records.values()].find(r=>r.company_id===name||r.identity?.display_name===name||r.identity?.aliases?.includes(name));if(entity&&!companies.some(c=>c.company_id===entity.company_id))throw Error('公司已收录，尚无可采集的招聘源：'+name);}
  for(const name of query.company_filters){const hits=companies.filter(c=>c.company_id===name||c.display_name===name||c.aliases?.includes(name));if(hits.length!==1||requested.has(hits[0].company_id))throw Error('公司范围含未识别（未收录）、歧义或重复公司：'+name);requested.add(hits[0].company_id);}
  const rows=companies.filter(c=>!requested.size||requested.has(c.company_id)).map(company=>{
    const record=records.get(company.company_id),tags=record?.tags||{},b=business.get(company.company_id),owner=owners.get(company.company_id),city=cities.get(company.company_id),reasons=[];
    if(!industryMatches(company,query.industry_filters))reasons.push('industry');
    if(query.ownership_filters.length&&!query.ownership_filters.includes(owner?ownershipDisplayTag(owner):tags.ownership))reasons.push('ownership');
    if(query.headquarters_country_filters.length&&!query.headquarters_country_filters.includes(tags.headquarters_country))reasons.push('headquarters_country');
    if(query.listing_status_filters.length&&!query.listing_status_filters.includes(tags.listing_status))reasons.push('listing_status');
    if(!businessMatches(tags.business||b?.business_tags||company.business_tags||[],query.business_filters,query.business_filter_match))reasons.push('business');
    if(requested.size&&reasons.length)throw Error('指定公司与'+reasons.map(r=>({industry:'行业',ownership:'性质',business:'业务',headquarters_country:'总部国家',listing_status:'上市状态'}[r])).join('、')+'范围冲突：'+company.display_name);
    if(plan&&!plan.company_ids.includes(company.company_id))reasons.push('targeted_plan');
    if(applyCities&&!companyCityMatches(city,query.city_filters))reasons.push(city?.cities?.length?'city_not_matched':'city_unknown');
    return {company,selected:reasons.length===0,reasons,city_tags:city?.cities||[],city_index_updated_at:city?.updated_at||null,city_coverage_complete:city?.city_coverage_complete===true};
  });
  if(plan){const eligible=new Set(rows.filter(r=>!r.reasons.some(x=>!['targeted_plan','city_not_matched','city_unknown'].includes(x))).map(r=>r.company.company_id));if(plan.company_ids.some(id=>!eligible.has(id)))throw Error('定向候选与行业或明确公司范围冲突');}
  return {query,companies:rows.filter(r=>r.selected).map(r=>r.company),rows,summary:{registered_companies:companies.length,selected_companies:rows.filter(r=>r.selected).length,city_excluded:rows.filter(r=>r.reasons.some(x=>x.startsWith('city_'))).length,excluded:rows.filter(r=>!r.selected).map(r=>({company_id:r.company.company_id,reasons:r.reasons})),city_index_updated_at:cityIndex?.updated_at||null}};
}
