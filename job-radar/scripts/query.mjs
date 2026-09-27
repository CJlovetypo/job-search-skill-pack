import {normalizeQuery,retrievalIssues,selectQueryCompanies} from '../../shared/job-search-core/scripts/lib/query-selection.mjs';
import {validateSearchPlan} from '../../shared/job-search-core/scripts/lib/targeted-search.mjs';
export function radarQuery(c){return normalizeQuery({mode:c.mode,industry_filters:c.industries,company_filters:c.company_ids,business_filters:c.business_filters,business_filter_match:c.business_filter_match,ownership_filters:c.ownership_filters,headquarters_country_filters:c.headquarters_country_filters,listing_status_filters:c.listing_status_filters,city_filters:c.cities,city_preference:c.city_preference,roles:c.roles||c.keywords,retrieval:c.retrieval,scope_basis:c.scope_basis,exclude_keywords:c.exclude_keywords});}
export function configIssues(c){
 const q=radarQuery(c),issues=retrievalIssues({...q,scopeKnown:!!(c.scope_basis||c.company_ids?.length||c.business_filters?.length||!q.industry_filters.includes('all'))});
 if(c.retrieval?.mode==='targeted'&&(!c.keywords?.length||c.keywords.some(k=>!c.keyword_reasons?.some(r=>r.keyword===k&&r.reason?.trim()))))issues.push({field:'keywords',question:'请保存定向标题词及语义依据。'});
 return issues;
}
export function normalizeRadarConfig(raw,companies,{allowPending=false,context={registry:{companies}}}={}){
 if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.id||''))throw Error('id 使用小写英文、数字和短横线，最多64字符');
 const words=(v,n)=>{if(v===undefined)return [];if(!Array.isArray(v)||v.some(x=>typeof x!=='string'||!x.trim()))throw Error(n+' 必须为字符串数组');return [...new Set(v.map(x=>x.trim()))].sort();};
 const keywords=words(raw.keywords,'keywords'),roles=words(raw.roles||keywords,'roles');
 const q=normalizeQuery({...raw,mode:raw.mode,industry_filters:raw.industries||['all'],company_filters:raw.company_ids,business_filters:raw.business_filters,city_filters:raw.cities,roles,exclude_keywords:raw.exclude_keywords});
 if(!roles.length&&!q.company_filters.length&&!q.business_filters.length&&q.industry_filters.includes('all'))throw Error('至少提供岗位目标、具体行业、业务或公司');
 const c={schema_version:2,id:raw.id,name:String(raw.name||raw.id),mode:q.mode,keywords,roles,exclude_keywords:q.exclude_keywords,company_ids:q.company_filters,cities:q.city_filters,city_preference:q.city_preference,industries:q.industry_filters,business_filters:q.business_filters,business_filter_match:q.business_filter_match,ownership_filters:q.ownership_filters,headquarters_country_filters:q.headquarters_country_filters,listing_status_filters:q.listing_status_filters,retrieval:q.retrieval,scope_basis:raw.scope_basis||null,keyword_reasons:raw.keyword_reasons||[]};
 selectQueryCompanies(context,{...radarQuery(c),...(context.records?{}:{ownership_filters:[],headquarters_country_filters:[],listing_status_filters:[]})},{applyCities:false});
 const issues=configIssues(c);if(!allowPending&&issues.length)throw Error(issues.map(i=>i.question).join('；'));
 return c;
}
export function radarSelection(c,context){return selectQueryCompanies(context,radarQuery(c));}
export function radarSearchPlan(c,selection,context){
 if(c.retrieval.mode!=='targeted'||!selection.companies.length)return null;
 const records=new Map((context.records?.companies||[]).map(r=>[r.company_id,r]));
 return validateSearchPlan({mode:'targeted',target:c.roles.join('、'),company_ids:selection.companies.map(x=>x.company_id),company_reasons:selection.companies.map(x=>({company_id:x.company_id,reason:'命中本次已确认公司筛选条件',business_basis:records.get(x.company_id)?.descriptions?.business_summary||JSON.stringify({industry:x.industry_tags||[],business:x.business_tags||[],query:selection.query})})),keywords:c.keywords,keyword_reasons:c.keyword_reasons,exclude_keywords:c.exclude_keywords},selection.companies);
}
