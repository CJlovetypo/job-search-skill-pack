// Read-only published company context. Maintenance lives in the private operations repository.
import fs from 'node:fs/promises';
import path from 'node:path';
import {CORE_ROOT,recruitmentFile,MODES} from '../../runtime-context.mjs';
import {readConsistentPublic} from './public-snapshot.mjs';
const text=v=>typeof v==='string'&&v.trim().length>0;
const get=(row,key)=>key.split('.').reduce((r,k)=>r?.[k],row);
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
export function indexById(dataset) {
  const map = new Map();
  for (const row of dataset?.companies || []) {
    if (!text(row.company_id) || map.has(row.company_id)) throw Error('缺失或重复公司ID：'+row.company_id);
    map.set(row.company_id, row);
  }
  return map;
}

export function projectCompanyRecords(records, inputs) {
  const result={...inputs,registry:{...inputs.registry,companies:inputs.registry.companies.map(c=>({...c}))},
    business:{...inputs.business},ownership:{...inputs.ownership},profiles:{...inputs.profiles}},byId=indexById(records);
  const published=(r,key)=>['fresh_web_review','api_search','demo_search'].includes(r.governance.fields[key]?.origin);
  const b=indexById(result.business),o=indexById(result.ownership),p=indexById(result.profiles);
  const sourceRows=new Map(result.registry.companies.map(c=>[c.company_id,c]));
  for(const record of records.companies) {
    const source=sourceRows.get(record.company_id)||record.identity;
    const r=byId.get(source.company_id),g=r.governance.fields,base={company_id:source.company_id,display_name:source.display_name};
    if(!b.has(source.company_id))b.set(source.company_id,{...base,business_tags:r.tags.business||[],business_summary:r.descriptions.business_summary||'',status:g['tags.business'].status,evidence:g['tags.business'].evidence||[]});
    if(!o.has(source.company_id))o.set(source.company_id,{...base,ownership_tag:r.tags.ownership||'待核实',status:g['tags.ownership'].status,evidence:g['tags.ownership'].evidence||[]});
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


async function loadPublishedInputs(){
 const files={registry:'assets/sources.json',business:'data/company-business-tags.json',ownership:'data/company-ownership-tags.json',profiles:'data/company-profiles.json',size:'data/company-size-tags.json'};
 const inputs=Object.fromEntries(await Promise.all(Object.entries(files).map(async([k,v])=>[k,await read(path.join(CORE_ROOT,v))])));
 inputs.cities=Object.fromEntries(await Promise.all(MODES.map(async mode=>[mode,await read(recruitmentFile(mode))])));return inputs;
}
export async function loadCompanyContext() {
 return readConsistentPublic(async()=>{
  const inputs=await loadPublishedInputs();
  const records=await read(path.join(CORE_ROOT,'data/company-records.json'));
  // Cities are maintained through their own public API index; static publication must not freeze them.
  for(const mode of MODES){const cities=indexById(inputs.cities[mode]);for(const row of records.companies){const city=cities.get(row.company_id);if(city){row.tags.recruitment[mode]={cities:city.cities||[]};row.governance.recruitment[mode]={origin:'official_job_observation',updated_at:city.updated_at||null,last_refresh_at:city.last_refresh_at||null,last_refresh_status:city.last_refresh_status||null,city_coverage_complete:city.city_coverage_complete||false};}}}
  return {...projectCompanyRecords(records,inputs),records,catalog:{total:records.companies.length,with_sources:inputs.registry.companies.length,without_sources:records.companies.filter(c=>!c.sources.length).map(c=>c.identity)}};
 });
}
