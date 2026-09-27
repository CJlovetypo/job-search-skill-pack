import fs from 'node:fs/promises';
import path from 'node:path';
import {PACK_ROOT,MODE_ROOTS} from '../runtime-context.mjs';
import {readSourceRegistry} from '../registry.mjs';

const apply=process.argv.includes('--apply');
if(process.argv.slice(2).some(arg=>arg!=='--apply'))throw Error('Usage: sync-company-city-index.mjs [--apply]');
const registry=await readSourceRegistry(),summary={apply,modes:{}};
for(const [mode,skill] of Object.entries(MODE_ROOTS)){
  const file=path.join(PACK_ROOT,skill,'company-city-index.json'),before=await fs.readFile(file,'utf8'),doc=JSON.parse(before),existing=new Map(doc.companies.map(row=>[row.company_id,row]));
  const companies=registry.companies.map(company=>existing.get(company.company_id)||{company_id:company.company_id,display_name:company.display_name,cities:[],updated_at:null,coverage:{status:'not_initialized',reason:'Source registered without a direction-specific city collection.'},search_mode:mode,formal_jobs_observed:0,target_jobs_observed:0,unknown_location_jobs:0,uncertain_type_or_status_jobs:0,city_coverage_complete:false,last_refresh_at:null,last_refresh_status:'not_initialized',last_refresh_reason:'Source registered without a direction-specific city collection.',city_evidence:[],retained_previous_cities:[],city_freshness:'unknown',city_evidence_total:0,city_evidence_scope:'none'});
  const added=companies.filter(row=>!existing.has(row.company_id)).length,next={...doc,updated_at:new Date().toISOString(),search_mode:mode,companies};
  summary.modes[mode]={before:doc.companies.length,after:companies.length,added,removed:doc.companies.length-companies.filter(row=>existing.has(row.company_id)).length};
  if(apply&&before!==JSON.stringify(next,null,2)+'\n')await fs.writeFile(file,JSON.stringify(next,null,2)+'\n');
}
console.log(JSON.stringify(summary,null,2));
