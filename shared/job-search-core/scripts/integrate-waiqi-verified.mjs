import {queueKeywordReviews} from './lib/source-keyword-maintenance.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {INDUSTRIES} from './lib/industry-routing.mjs';
import {planWaiqiIntegration} from './lib/waiqi-integration.mjs';
const root=path.resolve('shared/job-search-core/state/maintenance/waiqi-2026-09-20');
const registryFile=path.resolve('shared/job-search-core/assets/sources.json');
const apply=process.argv.includes('--apply');
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const hash=s=>createHash('sha256').update(s).digest('hex');
const inputs=[];
for(const folder of ['official-verification','official-greenhouse-verification','official-domestic-verification','official-zero-api-verification','official-zero-search-verification','routing-expansion-admission']){
 try{for(const item of await read(path.join(root,folder,'admitted.json')))inputs.push({item,file:path.join(root,folder,'admitted.json')});}catch(e){if(e.code!=='ENOENT')throw e;}
}
const before=await fs.readFile(registryFile,'utf8');
const {registry,added,skipped,rejected}=planWaiqiIntegration(JSON.parse(before),inputs,INDUSTRIES.map(x=>x.id));
const summary={checked_at:new Date().toISOString(),apply,input_sources:inputs.length,added_companies:added.filter(x=>x.new_company).length,added_configurations:added.length,already_registered:skipped.length,rejected:rejected.length,before_companies:JSON.parse(before).companies.length,after_companies:registry.companies.length,after_configurations:registry.companies.reduce((n,c)=>n+(c.recruitment_sources?.length||1),0),added,skipped,rejections:rejected};
await fs.writeFile(path.join(root,apply?'integration-result.json':'integration-plan.json'),JSON.stringify(summary,null,2)+'\n');
if(apply&&added.length){
 if(hash(await fs.readFile(registryFile,'utf8'))!==hash(before))throw Error('Registry changed during integration; rerun against its latest version');
 await fs.writeFile(path.join(root,`sources-before-apply-${Date.now()}.json`),before);
 registry.updated_at=summary.checked_at;
 registry.latest_waiqi_expansion_verified_at=summary.checked_at;
 registry.industry_counts=Object.fromEntries(INDUSTRIES.map(tag=>[tag.id,registry.companies.filter(c=>c.industry_tags?.includes(tag.id)).length]));
 const temporary=registryFile+`.waiqi-${process.pid}.tmp`;
 await fs.writeFile(temporary,JSON.stringify(registry,null,2)+'\n');
 if(hash(await fs.readFile(registryFile,'utf8'))!==hash(before)){await fs.unlink(temporary);throw Error('Registry changed while preparing atomic update; rerun against its latest version');}
 summary.keyword_review=await queueKeywordReviews(JSON.parse(before),registry,{registryFile:registryFile});
 await fs.rename(temporary,registryFile);
}
if(apply)await fs.writeFile(path.join(root,'integration-result.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({...summary,added:undefined,skipped:undefined,rejections:undefined},null,2));
