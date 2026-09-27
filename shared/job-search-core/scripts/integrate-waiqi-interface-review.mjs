import {queueKeywordReviews} from './lib/source-keyword-maintenance.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {INDUSTRIES} from './lib/industry-routing.mjs';
import {planWaiqiIntegration} from './lib/waiqi-integration.mjs';

const ROOT=path.resolve('shared/job-search-core/state/maintenance/waiqi-interface-deep-review/standard-ats');
const REGISTRY=path.resolve('shared/job-search-core/assets/sources.json');
const apply=process.argv.includes('--apply');
const read=file=>fs.readFile(file,'utf8').then(JSON.parse);
const digest=value=>createHash('sha256').update(value).digest('hex');

const inputFiles=[path.join(ROOT,'admitted.json'),path.join(ROOT,'zero-admitted.json'),path.join(ROOT,'contract-admitted.json')],inputs=[];
for(const file of inputFiles)for(const item of await read(file))inputs.push({item,file});
const before=await fs.readFile(REGISTRY,'utf8'),original=JSON.parse(before);
const plan=planWaiqiIntegration(original,inputs,INDUSTRIES.map(x=>x.id));
const summary={checked_at:new Date().toISOString(),apply,input_sources:inputs.length,added_companies:plan.added.filter(x=>x.new_company).length,added_configurations:plan.added.length,already_registered:plan.skipped.length,rejected:plan.rejected.length,before_companies:original.companies.length,after_companies:plan.registry.companies.length,after_configurations:plan.registry.companies.reduce((sum,company)=>sum+(company.recruitment_sources?.length||1),0),added:plan.added,skipped:plan.skipped,rejections:plan.rejected};
await fs.writeFile(path.join(ROOT,apply?'integration-result.json':'integration-plan.json'),JSON.stringify(summary,null,2)+'\n');
if(apply&&plan.added.length){
  if(digest(await fs.readFile(REGISTRY))!==digest(before))throw Error('Registry changed during integration; rerun against its latest version');
  plan.registry.updated_at=summary.checked_at;
  plan.registry.latest_waiqi_expansion_verified_at=summary.checked_at;
  plan.registry.industry_counts=Object.fromEntries(INDUSTRIES.map(tag=>[tag.id,plan.registry.companies.filter(company=>company.industry_tags?.includes(tag.id)).length]));
  const temporary=REGISTRY+`.waiqi-interface-${process.pid}.tmp`;
  await fs.writeFile(temporary,JSON.stringify(plan.registry,null,2)+'\n');
  if(digest(await fs.readFile(REGISTRY))!==digest(before)){await fs.unlink(temporary);throw Error('Registry changed while preparing atomic update');}
  summary.keyword_review=await queueKeywordReviews(original,plan.registry,{registryFile:REGISTRY});
 await fs.rename(temporary,REGISTRY);
}
if(apply)await fs.writeFile(path.join(ROOT,'integration-result.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({...summary,added:undefined,skipped:undefined,rejections:undefined},null,2));
