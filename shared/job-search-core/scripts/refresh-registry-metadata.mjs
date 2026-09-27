import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PACK_ROOT,MODE_ROOTS} from '../runtime-context.mjs';
import {SOURCE_REGISTRY_FILE,readSourceRegistry} from '../registry.mjs';
import {directionSourceKey,validatedDirectionRegistry} from './lib/direction-validation.mjs';
import {sourceDirectionPlan} from './lib/source-directions.mjs';

const registry=await readSourceRegistry(),bytes=await fs.readFile(SOURCE_REGISTRY_FILE);
const read=async p=>{try{return JSON.parse(await fs.readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const write=async(p,v)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(v,null,2)+'\n');};
for(const [mode,name] of Object.entries(MODE_ROOTS)){
 const root=path.join(PACK_ROOT,name),validation=mode==='campus'?null:await read(path.join(root,'source-direction-validation.json'));
 const gate=validatedDirectionRegistry(registry.companies,validation,mode),proofs=new Map((validation?.configurations||[]).map(r=>[r.key,r]));
 const count=registry.companies.reduce((n,c)=>n+(c.recruitment_sources?.length||1),0);
 const metadata={schema_version:1,mode,checked_at:new Date().toISOString(),source_registry:'shared/job-search-core/assets/sources.json',runtime:'shared/job-search-core',source_sha256:createHash('sha256').update(bytes).digest('hex'),companies:registry.companies.length,configurations:count,enabled_configurations:count,source_validation:{...gate,companies:undefined},note:'共享库存的派生摘要。运行直接读取共享来源；不需要同步或复制。历史核验仅在配置键一致时沿用。'};
 await write(path.join(root,'shared-registry.json'),metadata);
 if(mode!=='campus'){
  const configurations=registry.companies.flatMap(c=>(c.recruitment_sources?.length?c.recruitment_sources:[c]).map((s,i)=>{
   const proof=proofs.get(directionSourceKey(c,s,i));
   return {company_id:c.company_id,display_name:c.display_name,source_id:s.source_id||String(i),provider:s.provider,entry:s.primary_entry_url,...sourceDirectionPlan(s,mode),target_validation_status:proof?.status||'untested',enabled:true,proof_file:proof?.result_file||null};
  }));
  await write(path.join(root,'source-mode-capabilities.json'),{schema_version:1,mode,checked_at:metadata.checked_at,note:'方向路由与证据的派生索引；不是独立来源库，不控制启停。',configurations});
 }
 console.log(JSON.stringify({skill:name,companies:metadata.companies,configurations:count,enabled:count,pending:gate.unverified_configurations??null}));
}
