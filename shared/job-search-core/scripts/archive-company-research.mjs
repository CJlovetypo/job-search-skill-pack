import {publishPublicRecords} from './lib/public-company-data.mjs';
import {ARCHIVE_FILE,REVIEWS_FILE,API_LABELS_FILE,INTERNAL_RECORDS_FILE,RESEARCH_ROOT,RAW_ROOT,resolveResearchRecord} from '../maintenance-paths.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {CORE_ROOT,PACK_ROOT} from '../runtime-context.mjs';
import {INDUSTRIES} from './lib/industry-routing.mjs';
import {businessVocabulary} from './lib/business-taxonomy.mjs';
import {STATIC_FIELDS, loadCompanyInputs, buildCompanyRecords} from './lib/company-records.mjs';

const ROOT=path.join(PACK_ROOT,'datasets/company-research/raw');
const BATCHES=[
  ['perplexity_agent','perplexity-static-20260923',id=>`${id}.json`],
  ['linkup','search-providers-20260924',id=>`company-${id}.json`],
  ['tavily','tavily-gaps-20260924',id=>`${id}.json`],
  ['other_providers','other-provider-gaps-20260924',id=>`${id}.json`],
];
const FIELD=new Map(STATIC_FIELDS.map(key=>[key.split('.')[1],key]));
const isUrl=value=>{try{return ['http:','https:'].includes(new URL(value).protocol);}catch{return false;}};
const read=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
const unique=values=>[...new Set(values)];
const strip=value=>clean(value).toLowerCase().replace(/[\s（）()·・.,，。\-—_]/g,'');

export function archiveStructuredField(field, {provider,record,company,vocabulary,sources=[]}) {
  const key=FIELD.get(field.field);
  if(!key || field.evidence_status!=='supported' || !clean(field.value))return null;
  const raw=clean(field.value),urls=unique((field.source_urls||[]).filter(isUrl));
  let value=raw,issue=[];
  if(key==='tags.industry'||key==='tags.business') {
    value=unique(raw.split(/[,，;；]/).map(clean).filter(Boolean));
    const allowed=key==='tags.industry'?new Set(INDUSTRIES.map(x=>x.id)):vocabulary;
    if(!value.length||value.some(x=>!allowed.has(x)))issue.push('outside_existing_vocabulary');
  } else if(key==='tags.ownership'&&!['国企','私企','外企'].includes(raw))issue.push('invalid_ownership');
  else if(key==='tags.listing_status'&&!['已上市','未上市'].includes(raw))issue.push('invalid_listing_status');
  if(!urls.length)issue.push('missing_source_url');
  const names=[company.display_name,...(company.aliases||[])].map(strip).filter(x=>x.length>=3);
  const entity=strip(field.entity);
  if(!entity||!names.some(name=>entity.includes(name)||name.includes(entity)))issue.push('entity_requires_review');
  const matched=sources.filter(source=>urls.includes(source.url));
  if(provider==='linkup'&&urls.length&&!matched.length)issue.push('source_url_not_in_response');
  return {key,value,entity:field.entity||'',as_of:field.as_of||'',reason:field.reason||'',source_urls:urls,
    provider,source_record:record,checked_at:company.checked_at||null,
    review_state:'requires_independent_review',issues:unique(issue)};
}

export function summarizeCandidates(fields) {
  const proposals={};
  for(const [key,entries] of Object.entries(fields)) {
    const eligible=entries.filter(x=>x.issues.length===0);
    const values=unique(eligible.map(x=>JSON.stringify(x.value)));
    if(values.length===1)proposals[key]={value:eligible.at(-1).value,from:eligible.map(x=>x.provider),review_state:'requires_independent_review'};
    else if(values.length>1)for(const item of eligible)item.issues.push('conflicting_provider_values');
  }
  return proposals;
}

function supplemental(doc,provider,record) {
  const sources=provider==='tavily'?doc.results||[]:[...(doc.sources||[]),...(doc.retrieval?.results||[])];
  return {provider,source_record:record,checked_at:doc.checked_at||null,fields:doc.fields||[],query:doc.query||null,
    answer:doc.answer||null,sources:sources.filter(x=>isUrl(x.url)).map(x=>({url:x.url,title:x.title||x.name||'',excerpt:clean(x.content||x.snippet).slice(0,500)})),
    review_state:'search_material_only'};
}

export async function archiveAll({write=true}={}) {
  const inputs=await loadCompanyInputs();
  const vocabulary=new Set([...businessVocabulary(),...inputs.business.companies.flatMap(c=>c.business_tags||[])]);
  const companies=[];
  const metrics={companies:0,structured_company_records:0,supported_fields:0,candidate_fields:0,unresolved_skipped:0,issue_counts:{},supplemental_records:0};
  for(const company of inputs.registry.companies) {
    const fields={},supplemental_research=[],source_catalog=new Map();
    for(const [provider,folder,filename] of BATCHES) {
      const record=`job-search/artifacts/${folder}/${filename(company.company_id)}`;
      const doc=await read(resolveResearchRecord(record));
      if(!doc)continue;
      if(provider==='tavily'||provider==='other_providers') {
        supplemental_research.push(supplemental(doc,provider,record));metrics.supplemental_records++;continue;
      }
      const rawFields=doc.structured_output?.fields||[];
      if(rawFields.length)metrics.structured_company_records++;
      for(const source of doc.sources||doc.search_results||[])if(isUrl(source.url)&&!source_catalog.has(source.url))
        source_catalog.set(source.url,{url:source.url,title:source.name||source.title||'',excerpt:clean(source.content||source.snippet).slice(0,150),provider});
      for(const field of rawFields) {
        if(field.evidence_status!=='supported'){metrics.unresolved_skipped++;continue;}
        const item=archiveStructuredField(field,{provider,record,company:{...company,checked_at:doc.checked_at},vocabulary,sources:doc.sources||doc.search_results||[]});
        if(!item)continue;
        (fields[item.key]??=[]).push(item);metrics.supported_fields++;
        for(const issue of item.issues)metrics.issue_counts[issue]=(metrics.issue_counts[issue]||0)+1;
      }
    }
    const proposals=summarizeCandidates(fields);
    const cited=new Set(Object.values(fields).flatMap(items=>items.flatMap(item=>item.source_urls)));
    const sources=[...source_catalog.values()].map(source=>cited.has(source.url)?source:{url:source.url,title:source.title,provider:source.provider});
    metrics.candidate_fields+=Object.keys(proposals).length;
    companies.push({company_id:company.company_id,display_name:company.display_name,review_state:'requires_independent_review',
      proposals,fields,sources,supplemental_research});
  }
  metrics.companies=companies.length;
  const dataset={schema_version:1,updated_at:new Date().toISOString(),description:'Archived search findings; proposals are not verified company tags.',companies};
  if(write) {
    const target=ARCHIVE_FILE;
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.mkdir(path.dirname(INTERNAL_RECORDS_FILE),{recursive:true});
    await fs.writeFile(target,gzipSync(JSON.stringify(dataset)+'\n',{level:6}));
    const records=buildCompanyRecords({...inputs,research:dataset});
    await fs.writeFile(INTERNAL_RECORDS_FILE,JSON.stringify(records)+'\n');
  }
  return metrics;
}

async function main(args) {
  if(args[0]==='show') {
    const id=args[1];if(!id)throw Error('show 需要 company_id');
    const dataset=JSON.parse(gunzipSync(await fs.readFile(ARCHIVE_FILE)).toString('utf8'));
    const row=dataset.companies.find(x=>x.company_id===id);if(!row)throw Error('公司不在归档中：'+id);
    console.log(JSON.stringify(row,null,2));return;
  }
  if(args.length)throw Error('支持无参数重建，或 show company_id');
  console.log(JSON.stringify(await archiveAll()));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
