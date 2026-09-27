import {publishPublicRecords} from './lib/public-company-data.mjs';
import {withPublicationLock} from './lib/company-publication-transaction.mjs';
import {companyInputHashes} from './lib/company-review-publication.mjs';
import {bytesHash} from './lib/company-evidence.mjs';
import {ARCHIVE_FILE,REVIEWS_FILE,API_LABELS_FILE,INTERNAL_RECORDS_FILE,RESEARCH_ROOT,RAW_ROOT,resolveResearchRecord} from '../maintenance-paths.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {CORE_ROOT,PACK_ROOT} from '../runtime-context.mjs';
import {INDUSTRIES} from './lib/industry-routing.mjs';
import {businessVocabulary} from './lib/business-taxonomy.mjs';
import {STATIC_FIELDS,loadCompanyInputs,buildCompanyRecords,projectCompanyRecords,indexById} from './lib/company-records.mjs';

const ARCHIVE_ROOT=path.join(PACK_ROOT,'job-search/artifacts');
const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
const normal=value=>clean(value).toLowerCase().replace(/[\s（）()·・.,，。\-—_]/g,'');
const webUrl=value=>{try{return ['http:','https:'].includes(new URL(value).protocol);}catch{return false;}};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const titleText=source=>clean(source.title||source.name);
const bodyText=source=>clean(source.content||source.snippet||source.text);

function sourceRows(raw) {
  const rows=[...(raw.sources||[])];
  for(const group of raw.search_results||[])rows.push(...(group.results||[]));
  for(const group of raw.fetch_url_results||[])rows.push(...(group.contents||[]));
  return rows.filter(row=>webUrl(row.url));
}

export function validApiValue(key,value,vocabulary) {
  if(!STATIC_FIELDS.includes(key))return false;
  if(key==='tags.industry'||key==='tags.business') {
    const allowed=key==='tags.industry'?new Set(INDUSTRIES.map(x=>x.id)):vocabulary;
    return Array.isArray(value)&&value.length>0&&new Set(value).size===value.length&&value.every(x=>allowed.has(x));
  }
  if(key==='tags.ownership')return ['国企','私企','外企'].includes(value);
  if(key==='tags.listing_status')return ['已上市','未上市'].includes(value);
  return typeof value==='string'&&value.trim().length>0;
}

function sourceSupportsIdentity(source,company,item) {
  const hay=normal(titleText(source)+' '+bodyText(source));
  const names=[company.display_name,...(company.aliases||[]),item.entity].map(normal).filter(x=>x.length>=3);
  return names.some(name=>hay.includes(name));
}

async function rawFor(item,company,cache,inputHashes) {
  let file;try{file=resolveResearchRecord(item.source_record);}catch{return {problem:'source_record_outside_archive'};}const rel=path.relative(PACK_ROOT,file);
  if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))return {problem:'source_record_outside_archive'};
  if(!cache.has(file)) {
    try {const bytes=await fs.readFile(file);inputHashes[file]=bytesHash(bytes);cache.set(file,JSON.parse(bytes));}
    catch(e) {if(e.code==='ENOENT')inputHashes[file]=null;else if(!(e instanceof SyntaxError))throw e;cache.set(file,null);}
  }
  const raw=cache.get(file);
  if(!raw||raw.company_id!==company.company_id||raw.provider!==item.provider)return {problem:'source_record_or_identity_mismatch'};
  const field=raw.structured_output?.fields?.find(x=>x.field===item.key.split('.')[1]&&x.evidence_status==='supported'&&normal(x.value)===normal(Array.isArray(item.value)?item.value.join(','):item.value));
  if(!field)return {problem:'source_field_mismatch'};
  const sources=sourceRows(raw).filter(x=>item.source_urls.includes(x.url)&&bodyText(x));
  if(!sources.length)return {problem:'source_url_not_in_api_response'};
  const matched=sources.filter(x=>sourceSupportsIdentity(x,company,item));
  if(!matched.length)return {problem:'source_identity_unconfirmed'};
  return {evidence:matched.slice(0,1).map(source=>({url:source.url,title:titleText(source)||source.url,note:bodyText(source).slice(0,180),checked_at:item.checked_at,provider:item.provider,source_record:item.source_record}))};
}

export async function buildApiPublication(inputs,{archive=inputs.research,rechecks={companies:[]},inputHashes={}}={}) {
  const registry=indexById(inputs.registry),reviews=indexById(inputs.reviews),recheckMap=indexById(rechecks),vocabulary=new Set([...businessVocabulary(),...inputs.business.companies.flatMap(c=>c.business_tags||[])]);
  const counts=Object.fromEntries(STATIC_FIELDS.map(key=>[key,{published:0,conflict:0,pending:0,not_supported:0,existing_review:0}]));
  const pending=[],companies=[],cache=new Map();
  for(const entry of archive.companies||[]) {
    const company=registry.get(entry.company_id);if(!company)throw Error('研究档案包含未知公司：'+entry.company_id);
    const decisions={};
    for(const key of STATIC_FIELDS) {
      const prior=reviews.get(entry.company_id)?.decisions?.[key];
      if(prior){counts[key].existing_review++;continue;}
      const items=[...(entry.fields?.[key]||[]),...(recheckMap.get(entry.company_id)?.fields?.[key]||[])];
      if(!items.length){counts[key].not_supported++;continue;}
      const accepted=[],problems=[];
      for(const item of items) {
        if(!validApiValue(key,item.value,vocabulary)){problems.push('invalid_value');continue;}
        if((item.issues||[]).some(issue=>issue!=='conflicting_provider_values')){problems.push(...item.issues.filter(issue=>issue!=='conflicting_provider_values'));continue;}
        if(!Array.isArray(item.source_urls)||!item.source_urls.some(webUrl)||!Number.isFinite(Date.parse(item.checked_at))){problems.push('missing_source_or_time');continue;}
        const source=await rawFor(item,company,cache,inputHashes);
        if(source.problem){problems.push(source.problem);continue;}
        accepted.push({item,evidence:source.evidence});
      }
      const latestRecheck=accepted.filter(x=>x.item.recheck===true);
      const usable=latestRecheck.length?latestRecheck:accepted;
      const values=[...new Set(usable.map(x=>JSON.stringify(x.item.value)))];
      if(values.length>1){counts[key].conflict++;pending.push({company_id:entry.company_id,display_name:company.display_name,field:key,reason:'conflicting_provider_values',values:usable.map(x=>({provider:x.item.provider,value:x.item.value}))});continue;}
      if(!usable.length){counts[key].pending++;pending.push({company_id:entry.company_id,display_name:company.display_name,field:key,reason:[...new Set(problems)].join(',')||'no_qualified_api_result'});continue;}
      const selected=usable.at(-1),{item,evidence}=selected;
      decisions[key]={status:'api_supported',value:item.value,entity:item.entity,as_of:item.as_of||'',checked_at:item.checked_at,
        reason:item.reason||'API 返回有来源的字段结论；尚未独立核实',provider:item.provider,source_record:item.source_record,source_urls:item.source_urls,
        evidence,alternative_providers:[...new Set(usable.map(x=>x.item.provider))]};
      counts[key].published++;
    }
    if(Object.keys(decisions).length)companies.push({company_id:entry.company_id,display_name:company.display_name,decisions});
  }
  const totalPublished=Object.values(counts).reduce((sum,x)=>sum+x.published,0),existingReview=Object.values(counts).reduce((sum,x)=>sum+x.existing_review,0);
  return {labels:{schema_version:1,updated_at:new Date().toISOString(),status:'api_supported_not_independently_verified',companies},audit:{schema_version:1,updated_at:new Date().toISOString(),total_companies:registry.size,published_companies:companies.length,published_fields:totalPublished,existing_independent_review_fields:existingReview,
    pending_total:registry.size*STATIC_FIELDS.length-totalPublished-existingReview,conflicting_fields:Object.values(counts).reduce((sum,x)=>sum+x.conflict,0),recheck_queue_fields:pending.length,fields:counts,recheck_queue:pending}};
}

async function main() {
  return withPublicationLock(async()=>{
  const {assertMaintenanceInputs}=await import('../maintenance-paths.mjs');await assertMaintenanceInputs();await fs.access(ARCHIVE_FILE);
  const hashes=await companyInputHashes();
  hashes[ARCHIVE_FILE]=bytesHash(await fs.readFile(ARCHIVE_FILE));
  const inputs=await loadCompanyInputs({includeResearch:true});
  const recheckFile=path.join(RAW_ROOT,'company-api-rechecks-20260924/results.json');
  let rechecks={companies:[]};try{const bytes=await fs.readFile(recheckFile);hashes[recheckFile]=bytesHash(bytes);rechecks=JSON.parse(bytes);}catch(error){if(error.code!=='ENOENT')throw error;hashes[recheckFile]=null;}
  const {labels,audit}=await buildApiPublication(inputs,{rechecks,inputHashes:hashes});
  const records=buildCompanyRecords({...inputs,apiLabels:labels});
  const target=API_LABELS_FILE;
  await publishPublicRecords(records,projectCompanyRecords(records,inputs),{inputs:hashes,extraWrites:[
    {file:target,bytes:gzipSync(JSON.stringify(labels)+'\n',{level:6})},
    {file:INTERNAL_RECORDS_FILE,bytes:JSON.stringify(records)+'\n'}],metadata:{kind:'api_supported'}});
  await fs.writeFile(path.join(ARCHIVE_ROOT,'company-api-publication-audit-20260924.json'),JSON.stringify(audit,null,2)+'\n');
  const {recheck_queue,...summary}=audit;
  console.log(JSON.stringify(summary));
  });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error);process.exitCode=1;});
