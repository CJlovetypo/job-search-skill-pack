import fs from 'node:fs/promises';
import path from 'node:path';

const CANDIDATES=path.resolve('datasets/recruitment-links/catalog/waiqi-source-candidates.json');
const CATALOG=path.resolve(process.argv[2]||'datasets/recruitment-links/catalog/waiqi-interface-catalog.json');
const DEEP=path.resolve(process.argv[3]||'shared/job-search-core/state/maintenance/waiqi-interface-deep-review/no-interface-websites');
const SEARCH=path.resolve(process.argv[4]||'shared/job-search-core/state/maintenance/waiqi-2026-09-20/zero-position-source-discovery');
const OUTPUT=path.resolve(process.argv[5]||'datasets/recruitment-links/catalog/waiqi-interface-review-index.json');
const EXTRA_SEARCH=path.resolve(process.argv[6]||'shared/job-search-core/state/maintenance/waiqi-2026-09-20/missing-source-discovery');
const read=file=>fs.readFile(file,'utf8').then(JSON.parse);
const optional=async(file,fallback)=>{try{return await read(file);}catch(error){if(error.code==='ENOENT')return fallback;throw error;}};

const candidates=await read(CANDIDATES),catalog=await read(CATALOG);
const searchRuns=await Promise.all([SEARCH,EXTRA_SEARCH].map(async directory=>({
  candidates:await optional(path.join(directory,'discovery-candidates.json'),{candidates:[]}),
  noHit:await optional(path.join(directory,'no-hit.json'),[])
})));
const interfacesByCompany=new Map();
for(const row of catalog.interfaces)for(const id of row.waiqi_company_ids||[]){if(!interfacesByCompany.has(Number(id)))interfacesByCompany.set(Number(id),[]);interfacesByCompany.get(Number(id)).push(row);}
const searchCandidates=new Map();for(const search of searchRuns)for(const row of search.candidates.candidates||[]){if(!searchCandidates.has(Number(row.waiqi_company_id)))searchCandidates.set(Number(row.waiqi_company_id),[]);searchCandidates.get(Number(row.waiqi_company_id)).push(row);}
const noHitIds=new Set(searchRuns.flatMap(search=>search.noHit).map(row=>Number(row.waiqi_company_id)));
const companies=[];
for(const company of candidates.companies){
  const id=Number(company.waiqi_company_id),interfaces=interfacesByCompany.get(id)||[],deep=await optional(path.join(DEEP,String(id),'result.json'),null),registered=interfaces.filter(row=>row.status==='registered_source'),verifiedPending=interfaces.filter(row=>/^verified_/.test(row.status)&&row.status!=='registered_source');
  let review_state;
  if(registered.length)review_state='registered_api_source';
  else if(verifiedPending.length)review_state='verified_interface_pending_admission_or_identity';
  else if(interfaces.length)review_state='interface_or_career_candidate_pending_verification';
  else if(searchCandidates.has(id))review_state='search_candidate_pending_interface_verification';
  else if(deep)review_state='official_website_reviewed_no_supported_interface_found';
  else if(noHitIds.has(id))review_state='web_search_completed_no_supported_interface_found';
  else review_state='review_evidence_missing';
  companies.push({waiqi_company_id:id,display_name:company.display_name,aliases:company.aliases||[],ownership_hint:company.ownership_hint||null,industry_hint:company.industry_hint||null,website:company.website||null,source_url:company.source_url,review_state,interfaces:interfaces.map(row=>({interface_id:row.interface_id,provider:row.provider,status:row.status,entry_url:row.entry_url,api_config:row.api_config||{}})),website_review:deep?{status:deep.status,job_details_requested:deep.job_details_requested||0}:null,search_review:searchCandidates.has(id)?{status:'candidate_found',candidate_count:searchCandidates.get(id).length}:noHitIds.has(id)?{status:'completed_no_candidate'}:null});
}
const counts=companies.reduce((out,row)=>(out[row.review_state]=(out[row.review_state]||0)+1,out),{});
const output={schema_version:1,generated_at:new Date().toISOString(),company_snapshot_at:candidates.checked_at,companies_reviewed:companies.length,review_state_counts:counts,policy:'One row per Waiqi company. Stores company facts, company/career entrances and interface configurations only. Search hits and HTTP success remain candidates until interface and employer identity verification; no individual job details are stored.',companies};
await fs.mkdir(path.dirname(OUTPUT),{recursive:true});await fs.writeFile(OUTPUT,JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({companies:companies.length,states:counts,output:OUTPUT},null,2));
