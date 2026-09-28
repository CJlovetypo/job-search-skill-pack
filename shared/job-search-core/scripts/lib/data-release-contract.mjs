// Public data shape and integrity checks only. No publishing or repair side effects.
import {createHash} from 'node:crypto';
import {validateIndustryTags} from './industry-routing.mjs';
import {publicCompanyRecords,publicCompatibility,publicUrl} from './public-company-data.mjs';
export const DATA_CONTRACT_VERSION=1;
export const DATA_FILES=Object.freeze([
 'assets/sources.json','assets/custom-providers.json','data/business-taxonomy.json',
 ...['records','business-tags','ownership-tags','profiles','size-tags'].map(n=>'data/company-'+n+'.json'),
 'data/source-search-capabilities.json',
 ...['campus','internship','social'].flatMap(mode=>['company-city-index.json','shared-registry.json',...(mode==='campus'?[]:['source-direction-validation.json','source-mode-capabilities.json'])].map(n=>`data/recruitment/${mode}/${n}`)),
]);
export const OPTIONAL_DATA_FILES=Object.freeze(['data/recruitment/campus/source-direction-validation.json','data/recruitment/campus/source-mode-capabilities.json']);
export const bytesHash=b=>createHash('sha256').update(b).digest('hex');
export const contentHash=files=>bytesHash(JSON.stringify(Object.entries(files).sort(([a],[b])=>a.localeCompare(b))));
export function assertReleasePath(name){if(![...DATA_FILES,...OPTIONAL_DATA_FILES].includes(name))throw Error('Release path outside allowlist: '+name);}
const privateField=/^(?:raw_response|structured_output|supplemental_research|research_candidates|repair_history|repair_id|source_record|credentials|password|authorization|cookie|set-cookie)$/i;
const evidenceFile=/(?:^|_)(?:raw|response|result|evidence|archive|review|proof|verification|discovery|semantic_review)_?file$|^evidence_files$/i;
const privatePath=/(?:\b[A-Z]:[\\/]|(?:^|[\s"'])(?:datasets|maintenance|docs)\/|(?:job-search|job-radar)\/(?:artifacts|runs)\/|shared\/job-search-core\/state\/)/i;
export function publicOperationalValue(value){
 if(typeof value==='string')return privatePath.test(value)?undefined:value;
 if(Array.isArray(value))return value.map(publicOperationalValue).filter(v=>v!==undefined);
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).filter(([k])=>!privateField.test(k)&&!evidenceFile.test(k)).flatMap(([k,v])=>{const x=publicOperationalValue(v);return x===undefined?[]:[[k,x]];}));
}
export function assertPublicOperationalValue(value){if(JSON.stringify(value)!==JSON.stringify(publicOperationalValue(value)))throw Error('Private field or local evidence path in release');}
const pick=(v,keys)=>Object.fromEntries(keys.filter(k=>v?.[k]!==undefined).map(k=>[k,v[k]]));
const SOURCE_FIELDS=['company_id','display_name','aliases','industry_tags','source_id','provider','primary_entry_url','alternative_entry_urls','additional_entry_urls','api_config','validated_api_request_examples','public_bootstrap_requests','official_job_url_template','list_page_size','project_type','job_namespace','route_evidence_url','verification_status','verified_at','api_verified_at','admitted','source_relationship'];
export function publicSourceRegistry(registry){
 const source=row=>{
  const out=pick(row,SOURCE_FIELDS);
  if(row.identity_verification)out.identity_verification=pick(row.identity_verification,['identity_verified','verified_at','evidence_url','official_name','official_brand','matched_alias','response_sha256']);
  if(row.source_verification)out.source_verification=pick(row.source_verification,['status','method','scope','checked_at','attempted_mode','direction_status','coverage_status','list_complete','observed_jobs','target_jobs','complete_jd_samples','official_identity_url']);
  return publicOperationalValue(out);
 };
 return {...pick(registry,['schema_version','verified_on','policy','updated_at','industry_counts']),companies:registry.companies.map(c=>({...source(c),...(c.recruitment_sources?{recruitment_sources:c.recruitment_sources.map(source)}:{})}))};
}
export function validateDataSnapshot(files,{providers}={}){
 for(const name of DATA_FILES)if(!Object.hasOwn(files,name))throw Error('Incomplete release: '+name);
 for(const [name,value]of Object.entries(files)){assertReleasePath(name);assertPublicOperationalValue(value);}
 const registry=files['assets/sources.json'],records=files['data/company-records.json'];
 if(!Array.isArray(registry?.companies)||!Array.isArray(records?.companies))throw Error('Missing company arrays');
 if(JSON.stringify(registry)!==JSON.stringify(publicSourceRegistry(registry)))throw Error('Public source schema whitelist mismatch');
 if(JSON.stringify(records)!==JSON.stringify(publicCompanyRecords(records)))throw Error('Public company schema mismatch');
 for(const [suffix,kind]of [['business-tags','business'],['ownership-tags','ownership'],['profiles','profiles'],['size-tags','size']]){
  const data=files['data/company-'+suffix+'.json'];if(JSON.stringify(data)!==JSON.stringify(publicCompatibility(kind,data)))throw Error('Compatibility schema mismatch: '+suffix);
 }
 function ids(rows,label){const result=new Set();for(const row of rows){if(typeof row.company_id!=='string'||!row.company_id||result.has(row.company_id))throw Error('Duplicate or invalid company ID: '+label);result.add(row.company_id);}return result;}
 const subjects=ids(records.companies,'records'),sources=ids(registry.companies,'sources');
 for(const c of records.companies){if(c.identity?.company_id!==c.company_id)throw Error('Identity ID mismatch');validateIndustryTags(c.tags.industry);}
 for(const c of registry.companies){
  if(!subjects.has(c.company_id))throw Error('Source references missing subject');const sourceIds=new Set();
  for(const s of c.recruitment_sources?.length?c.recruitment_sources:[c]){
   if(providers&&!providers.includes(s.provider))throw Error('Unsupported provider: '+s.provider);
   if(!['http:','https:'].includes(new URL(s.primary_entry_url).protocol))throw Error('Invalid source URL');
   if(s.source_id&&sourceIds.has(s.source_id))throw Error('Duplicate source ID');sourceIds.add(s.source_id);
  }
  const record=records.companies.find(r=>r.company_id===c.company_id);
  validateIndustryTags(c.industry_tags);
  if(JSON.stringify([...c.industry_tags].sort())!==JSON.stringify([...record.tags.industry].sort()))throw Error('Company/source industry mismatch: '+c.company_id);
  const expected=(c.recruitment_sources?.length?c.recruitment_sources:[c]).map(s=>[s.source_id||null,s.provider,publicUrl(s.primary_entry_url)]);
  const actual=(record.sources||[]).map(s=>[s.source_id||null,s.provider,s.url]);if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Company/source projection mismatch: '+c.company_id);
 }
 for(const c of records.companies)if(!sources.has(c.company_id)&&c.sources?.length)throw Error('Subject has dangling source summary');
 for(const [name,data]of Object.entries(files))if(name.startsWith('data/')&&name!=='data/company-records.json'){
  if(Array.isArray(data.companies)){ids(data.companies,name);for(const c of data.companies)if(!subjects.has(c.company_id))throw Error('Unknown company in '+name);}
  for(const row of Array.isArray(data.configurations)?data.configurations:[])if(row.company_id&&!subjects.has(row.company_id))throw Error('Unknown capability company');
 }
 return {subjects:subjects.size,with_sources:sources.size,without_sources:subjects.size-sources.size,configurations:registry.companies.reduce((n,c)=>n+(c.recruitment_sources?.length||1),0)};
}
