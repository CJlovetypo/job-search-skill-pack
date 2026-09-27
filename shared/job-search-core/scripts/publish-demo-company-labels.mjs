import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {ARCHIVE_FILE,DEMO_LABELS_FILE,INTERNAL_RECORDS_FILE} from '../maintenance-paths.mjs';
import {CORE_ROOT,PACK_ROOT} from '../runtime-context.mjs';
import {INDUSTRIES} from './lib/industry-routing.mjs';
import {businessVocabulary} from './lib/business-taxonomy.mjs';
import {STATIC_FIELDS,buildCompanyRecords,indexById,loadCompanyInputs,projectCompanyRecords} from './lib/company-records.mjs';
import {bytesHash} from './lib/company-evidence.mjs';
import {companyInputHashes} from './lib/company-review-publication.mjs';
import {publishPublicRecords} from './lib/public-company-data.mjs';

export const DEMO_BATCH='company-profile-demo-20260927';
const text=value=>typeof value==='string'&&value.trim().length>0;
const get=(row,key)=>key.split('.').reduce((value,part)=>value?.[part],row);
const present=value=>Array.isArray(value)?value.length>0:text(value);
const has=value=>present(value)&&value!=='待核实'&&!(Array.isArray(value)&&value.length===1&&value[0]==='待核实');
const canonical=value=>JSON.stringify(value);
const web=value=>{try{return ['http:','https:'].includes(new URL(value).protocol);}catch{return false;}};
const placeholders={
  'tags.business':['待核实'],'tags.ownership':'待核实','tags.headquarters_country':'待核实','tags.listing_status':'待核实',
  'descriptions.business_summary':'现有联网材料未形成可用业务概述，待后续补充。',
  'descriptions.products_services':'现有联网材料未形成可用产品或服务描述，待后续补充。',
  'descriptions.customers':'现有联网材料未公开披露明确客户信息。',
  'descriptions.business_regions':'现有联网材料未公开披露明确业务地区。',
  'descriptions.workforce':'现有联网材料未公开披露可用员工人数。',
  'descriptions.capital':'现有联网材料未公开披露可用资本信息。',
  'descriptions.entity_relationships':'现有联网材料未公开披露明确主体关系。',
};

function normalize(key,value,{industries,business}) {
  const parts=Array.isArray(value)?value:String(value??'').split(/[，,、;；/]/).map(x=>x.trim()).filter(Boolean);
  if(key==='tags.industry')return [...new Set(parts.filter(v=>industries.has(v)))];
  if(key==='tags.business')return [...new Set(parts.filter(v=>business.has(v)))];
  if(key==='tags.ownership') {
    const raw=String(value??'');
    const hits=['国企','私企','外企'].filter(v=>raw===v||raw.startsWith(v+'；')||raw.startsWith(v+'（'));
    return hits.length===1?hits[0]:null;
  }
  if(key==='tags.listing_status') {
    const raw=String(value??'').toLowerCase();
    if(/未上市|非上市|未单独上市|private|拟上市|递交.*上市|ipo辅导/.test(raw))return '未上市';
    if(/退市|delisted/.test(raw))return '未上市';
    if(/上市|listed|挂牌/.test(raw)&&!/部分子公司上市|控股上市公司/.test(raw))return '已上市';
    return null;
  }
  if(Array.isArray(value))value=value.filter(text).join('、');
  return text(value)?value.trim():null;
}

function evidence(item) {
  return [...new Set((item?.source_urls||[]).filter(web))].slice(0,3).map(url=>({url,title:item.provider?`${item.provider} 搜索材料`:'联网搜索材料',
    note:String(item.reason||'该链接来自已归档联网候选。').slice(0,180),checked_at:item.checked_at||null,provider:item.provider||'archived_search'}));
}

function choose(candidate,key,allowed) {
  const proposal=candidate?.proposals?.[key],items=(candidate?.fields?.[key]||[]).map(item=>({...item,normalized:normalize(key,item.value,allowed)})).filter(item=>has(item.normalized));
  const proposed=normalize(key,proposal?.value,allowed);
  const exact=has(proposed)?items.filter(item=>canonical(item.normalized)===canonical(proposed)):[];
  const pool=(exact.length?exact:items).sort((a,b)=>Number((a.issues||[]).length===0)-Number((b.issues||[]).length===0)||Date.parse(a.checked_at||0)-Date.parse(b.checked_at||0));
  const item=pool.at(-1);
  if(item)return {value:has(proposed)?proposed:item.normalized,item};
  if(has(proposed))return {value:proposed,item:null};
  return null;
}

export function buildDemoLabels(inputs,{formal,now=new Date().toISOString()}={}) {
  const candidates=indexById(inputs.research),formalById=indexById(formal),industries=new Set(INDUSTRIES.map(x=>x.id));
  const business=new Set([...businessVocabulary(),...inputs.business.companies.flatMap(x=>x.business_tags||[]).filter(text)]);business.add('待核实');
  const existingDemo=indexById(inputs.demoLabels);
  const allowed={industries,business},companies=[],counts=Object.fromEntries(STATIC_FIELDS.map(field=>[field,{candidate:0,formal_fallback:0,searched_no_value:0,preserved_verified:0,preserved_api:0}]));
  for(const company of inputs.registry.companies) {
    const current=formalById.get(company.company_id),candidate=candidates.get(company.company_id),decisions={};
    for(const key of STATIC_FIELDS) {
      const governance=current?.governance?.fields?.[key];
      if(governance?.status==='verified'&&governance?.origin==='fresh_web_review'){counts[key].preserved_verified++;continue;}
      const classified=existingDemo.get(company.company_id)?.decisions?.[key];
      if(classified?.method==='local_description_classification'){
        decisions[key]=structuredClone(classified);counts[key].preserved_classification=(counts[key].preserved_classification||0)+1;continue;
      }
      if(governance?.status==='api_supported'){counts[key].preserved_api++;continue;}
      const selected=choose(candidate,key,allowed),fallback=normalize(key,get(current,key),allowed);
      let value,item,availability;
      if(selected){({value,item}=selected);availability='candidate_value';counts[key].candidate++;}
      else if(has(fallback)){value=fallback;item=null;availability='formal_fallback';counts[key].formal_fallback++;}
      else {value=placeholders[key];item=null;availability='searched_no_value';counts[key].searched_no_value++;}
      if(!present(value))throw Error('Demo field has no value: '+company.company_id+' '+key);
      decisions[key]={status:'demo_unreviewed',value,entity:item?.entity||company.display_name,as_of:item?.as_of||governance?.as_of||'',checked_at:item?.checked_at||now,
        reason:item?.reason||governance?.reason||(availability==='searched_no_value'?'现有供应商与Codex联网搜索档案均未形成该字段的可用事实；首版保留显式待补值。':'沿用现有正式值作为首版画像，尚未独立复核。'),
        provider:item?.provider||'archived_search',source_record:item?.source_record||'datasets/company-research/candidates/company-research-candidates.json.gz',
        source_urls:item?.source_urls||[],evidence:item?evidence(item):[],demo_batch:DEMO_BATCH,data_availability:availability};
    }
    if(Object.keys(decisions).length)companies.push({company_id:company.company_id,display_name:company.display_name,decisions});
  }
  const labels={schema_version:1,updated_at:now,status:'formal_demo_unreviewed',demo_batch:DEMO_BATCH,companies};
  const all=buildCompanyRecords({...inputs,demoLabels:labels},{now}),missing=[];
  for(const row of all.companies)for(const key of STATIC_FIELDS)if(!present(get(row,key)))missing.push({company_id:row.company_id,field:key});
  if(missing.length)throw Error('Demo still has empty formal fields: '+JSON.stringify(missing.slice(0,8)));
  return {labels,records:all,audit:{schema_version:1,generated_at:now,demo_batch:DEMO_BATCH,companies:inputs.registry.companies.length,field_slots:inputs.registry.companies.length*STATIC_FIELDS.length,empty_fields:0,counts}};
}

async function main() {
  const classificationAt=process.argv.indexOf('--classification-file');
  if(classificationAt!==-1){
    if(!process.argv[classificationAt+1]||process.argv[classificationAt+1].startsWith('--'))throw Error('--classification-file needs a file');
    const {publishClassification}=await import('./lib/company-classification.mjs');
    console.log(JSON.stringify(await publishClassification(process.argv[classificationAt+1],{publish:process.argv.includes('--publish')}),null,2));return;
  }
  const publish=process.argv.includes('--publish'),inputs=await loadCompanyInputs({includeResearch:true}),formal=JSON.parse(await fs.readFile(path.join(CORE_ROOT,'data/company-records.json'),'utf8'));
  const {labels,records,audit}=buildDemoLabels(inputs,{formal}),artifact=path.join(PACK_ROOT,'shared/job-search-core/state/maintenance/company-profile-demo-20260927-audit.json');
  if(!publish){console.log(JSON.stringify(audit,null,2));return;}
  const hashes=await companyInputHashes();hashes[ARCHIVE_FILE]=bytesHash(await fs.readFile(ARCHIVE_FILE));hashes[path.join(CORE_ROOT,'data/company-records.json')]=bytesHash(await fs.readFile(path.join(CORE_ROOT,'data/company-records.json')));
  const compatibility=projectCompanyRecords(records,inputs);
  await publishPublicRecords(records,compatibility,{inputs:hashes,extraWrites:[
    {file:DEMO_LABELS_FILE,bytes:gzipSync(JSON.stringify(labels)+'\n',{level:6})},
    {file:INTERNAL_RECORDS_FILE,bytes:JSON.stringify(records)+'\n'},
    {file:artifact,bytes:JSON.stringify(audit,null,2)+'\n'}],metadata:{kind:'demo_unreviewed',demo_batch:DEMO_BATCH}});
  console.log(JSON.stringify({...audit,published:true,artifact},null,2));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error);process.exitCode=1;});
