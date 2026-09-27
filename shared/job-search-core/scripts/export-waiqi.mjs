import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {csvCell,recruitmentLink} from './lib/waiqi-utils.mjs';

const core=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.resolve(core,'../..');
const input=path.resolve(process.argv[2]||path.join(root,'shared/job-search-core/state/maintenance/waiqi-2026-09-20'));
const read=async p=>{try{return JSON.parse(await fs.readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const write=async(p,x)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(x,null,2)+'\n');};
const registry=await read(path.join(core,'assets/sources.json'));
const list=await read(path.join(input,'company-list.json'));
if(!list)throw Error('Run crawl-waiqi.mjs first');
const norm=s=>String(s||'').toLowerCase().replace(/[\s（）()·.,，&＆-]/g,'');
const names=new Map(),tenants=new Map();
const add=(map,k,v)=>{if(!k)return;if(!map.has(k))map.set(k,new Set());map.get(k).add(v);};
function tenant(url){try{const u=new URL(url);if(u.hostname.endsWith('.myworkdayjobs.com')){const p=u.pathname.split('/').filter(Boolean).filter(x=>!/^\w{2}-\w{2}$/.test(x));return u.hostname.toLowerCase()+'/'+p[0];}if(/(?:jobs\.)?smartrecruiters\.com$/.test(u.hostname))return 'smartrecruiters/'+u.pathname.split('/').filter(Boolean)[0]?.toLowerCase();if(/\.zhiye\.com$/.test(u.hostname))return u.hostname;const m=u.pathname.match(/\/(?:social-recruitment|campus-recruitment|apply|campus_apply)\/([^/]+)\/([^/]+)/);if(m)return u.hostname+'/'+m[1]+'/'+m[2];return null;}catch{return null;}}
for(const c of registry.companies){for(const name of [c.display_name,...c.aliases||[]])add(names,norm(name),c.company_id);for(const s of c.recruitment_sources?.length?c.recruitment_sources:[c])add(tenants,tenant(s.primary_entry_url),c.company_id);}
const companies=[],jobs=new Map(),failures=[],discrepancies=[];
for(const row of list.companies){
 const info=await read(path.join(input,`companies/${row.id}.json`));const pos=await read(path.join(input,`positions/${row.id}.json`));
 const d=info?.success?info.data:{};const rows=pos?.success&&Array.isArray(pos.data)?pos.data:[];
 if(!info?.success)failures.push({id:row.id,phase:'company',error:info?.error||'not_fetched'});
 if(!pos?.success)failures.push({id:row.id,phase:'positions',error:pos?.error||'not_fetched'});
 const links=new Map(),instructions=new Set();const website=d.website||null;
 for(const j of rows){const key=`${j.posType||1}:${j.id}`,parsed=recruitmentLink(j.outsideUrl),url=parsed.url;
  if(url){if(!links.has(url))links.set(url,{url,kind:'position',raw:parsed.raw,normalization:parsed.normalization,job_ids:[]});links.get(url).job_ids.push(String(j.id));}else if(parsed.raw)instructions.add(parsed.raw);
  const entry={waiqi_job_id:j.id,waiqi_company_id:row.id,company_name:row.name,title:j.name,title_en:j.nameEn,city_hint:j.cityNameList,job_type_hint:j.postTypeName,education_hint:j.educationName,experience_hint:j.workExpName,updated_at:j.updateTime,external_url:url,external_url_raw:parsed.raw,link_normalization:parsed.normalization,source_url:`https://waiqi.com/position/detail?id=${j.id}&posType=${j.posType||1}`,source_status:j.status,description:j.description||null};
  const detail=await read(path.join(input,`job-details/${key.replace(':','-')}.json`));
  if(detail?.success&&String(detail.data?.id)===String(j.id)){
   entry.detail=detail.data;entry.description=detail.data.description||entry.description;entry.detail_fetched_at=detail.fetched_at;
   if(!entry.external_url){const recovered=recruitmentLink(detail.data.outsideUrl);if(recovered.url){entry.external_url=recovered.url;entry.external_url_raw=recovered.raw;entry.link_normalization=recovered.normalization;entry.link_source='job_detail';if(!links.has(recovered.url))links.set(recovered.url,{url:recovered.url,kind:'position',raw:recovered.raw,normalization:recovered.normalization,job_ids:[]});links.get(recovered.url).job_ids.push(String(j.id));}}
  }else if(detail)failures.push({id:row.id,job_id:j.id,phase:'job_detail',error:detail.error||'job_detail_identity_mismatch'});
  if(jobs.has(key)){const prior=jobs.get(key);prior.also_listed_under_company_ids=[...new Set([...(prior.also_listed_under_company_ids||[]),row.id])];}else jobs.set(key,entry);
 }
 const aliases=[...new Set([row.abbreviation,d.name,d.nameEn,d.fullNameEn,d.abbreviationEn].filter(x=>x&&x!==row.name))];
 const matches=new Map();for(const n of [row.name,...aliases])for(const id of names.get(norm(n))||[])add(matches,id,'exact_normalized_name');
 for(const l of links.values())for(const id of tenants.get(tenant(l.url))||[])add(matches,id,'same_recruitment_tenant_requires_entity_review');
 const count=d.positionCount??row.positionCount??null;
 if(pos?.success&&count!==null&&count!==rows.length)discrepancies.push({id:row.id,reported:count,returned:rows.length});
 companies.push({waiqi_company_id:row.id,display_name:row.name,aliases,industry_hint:d.businessDictName||row.businessDictName||null,ownership_hint:d.companyType||row.companyType||null,scale_hint:d.scaleName||row.scaleName||null,city_hint:d.cityNameList||row.cityNameList||null,website,introduction:d.introduce||null,welfare_hint:d.welfare?.map(x=>x.name)||[],source_url:`https://waiqi.com/company/detail?id=${row.id}`,recruitment_links:[...links.values()],matched_company_ids:[...matches.keys()],match_evidence:[...matches].map(([company_id,basis])=>({company_id,basis:[...basis]})),status:!pos?.success?'positions_fetch_incomplete':links.size?'discovered_unverified':'no_external_recruitment_link',reported_position_count:count,returned_position_count:rows.length,company_detail_fetched_at:info?.fetched_at||null,positions_fetched_at:pos?.fetched_at||null,position_observation_kind:pos?.observation_kind||(pos?.success?'position_list_response':'unavailable'),evidence_files:{company:`companies/${row.id}.json`,positions:`positions/${row.id}.json`}});
 companies.at(-1).non_url_recruitment_instructions=[...instructions];
}
const stats={generated_at:new Date().toISOString(),reported_companies:list.reported_total,companies:companies.length,company_details_ok:companies.filter(x=>x.company_detail_fetched_at).length,position_lists_ok:companies.filter(x=>x.positions_fetched_at).length,companies_with_external_links:companies.filter(x=>x.recruitment_links.length).length,companies_with_registry_match_hints:companies.filter(x=>x.matched_company_ids.length).length,unique_jobs:jobs.size,jobs_with_external_links:[...jobs.values()].filter(x=>x.external_url).length,unique_external_links:new Set([...jobs.values()].map(x=>x.external_url).filter(Boolean)).size,job_details_ok:[...jobs.values()].filter(x=>x.detail_fetched_at).length,failures:failures.length,position_count_discrepancies:discrepancies.length};
stats.zero_positions_confirmed_by_company_api=companies.filter(x=>x.position_observation_kind==='position_list_response'&&x.returned_position_count===0).length;
stats.position_observations_ok=stats.position_lists_ok;
stats.position_lists_ok=companies.filter(x=>x.position_observation_kind==='position_list_response').length;
stats.links_extracted_from_prefixed_text=[...jobs.values()].filter(x=>x.external_url&&x.link_normalization==='extracted_explicit_url').length;
stats.non_url_recruitment_instructions=[...jobs.values()].filter(x=>x.external_url_raw&&!x.external_url).length;
const pendingDetails=[...jobs.values()].filter(x=>!x.external_url&&!x.detail_fetched_at).map(x=>({waiqi_job_id:x.waiqi_job_id,waiqi_company_id:x.waiqi_company_id,title:x.title,source_url:x.source_url,status:'supplemental_detail_pending'}));
stats.job_details_pending=pendingDetails.length;
await write(path.join(input,'job-details-pending.json'),pendingDetails);
await write(path.resolve(core,'../../datasets/recruitment-links/catalog/waiqi-source-candidates.json'),{schema_version:1,source:'https://waiqi.com/company',checked_at:stats.generated_at,policy:'Discovery only. Supplier ownership, location and scale are unverified hints. External links do not establish active vacancies or verified official API capability. matched_company_ids require entity review; never automatically merge.',coverage:stats,companies});
await write(path.join(input,'summary.json'),stats);await write(path.join(input,'failures.json'),failures);await write(path.join(input,'position-count-discrepancies.json'),discrepancies);
await fs.writeFile(path.join(input,'jobs.jsonl'),[...jobs.values()].map(x=>JSON.stringify(x)).join('\n')+'\n');
const cell=csvCell;
async function csv(name,headers,rows){await fs.writeFile(path.join(input,name),'\ufeff'+[headers,...rows].map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n');}
await csv('companies.csv',['waiqi公司ID','公司名称','别名','行业线索','性质线索','规模线索','城市线索','官网','公司介绍','来源页面','岗位返回数','外部链接数','匹配现有主体线索','抓取状态'],companies.map(c=>[c.waiqi_company_id,c.display_name,c.aliases.join('；'),c.industry_hint,c.ownership_hint,c.scale_hint,c.city_hint,c.website,c.introduction,c.source_url,c.returned_position_count,c.recruitment_links.length,c.matched_company_ids.join(';'),c.status]));
await csv('recruitment-links.csv',['waiqi公司ID','公司名称','waiqi岗位ID','岗位名称','英文岗位名称','城市线索','招聘类型线索','更新时间','招聘原站链接','waiqi岗位页面','原始招聘链接或说明','链接提取方式','站内岗位正文（已抓取部分）','详情抓取时间'],[...jobs.values()].map(j=>[j.waiqi_company_id,j.company_name,j.waiqi_job_id,j.title,j.title_en,j.city_hint,j.job_type_hint,j.updated_at,j.external_url,j.source_url,j.external_url_raw,j.link_normalization,j.description,j.detail_fetched_at]));
console.log(JSON.stringify(stats,null,2));
