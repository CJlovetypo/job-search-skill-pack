import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {configureRuntime,recruitmentFile,CORE_ROOT,runtimeContext} from '../runtime-context.mjs';
import {loadCompanyContext} from './lib/company-records.mjs';
import {selectQueryCompanies} from './lib/query-selection.mjs';
import {refreshedCityTag} from './lib/city-index.mjs';
import {normalizeRetrievedJob} from './lib/job-retrieval.mjs';
import {collectCompanySources,sourceConfigFingerprint} from './lib/source-collector.mjs';
import {writeJson,mapLimit,stamp} from './lib/io.mjs';
export async function refreshCities({mode,only,industries,out,resume=false,concurrency=2,maxPages=100}={}){
 if(!runtimeContext().mode)configureRuntime({mode});
 else if(runtimeContext().mode!==mode)throw Error('城市维护招聘方向与运行上下文不一致');
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8||!Number.isInteger(maxPages)||maxPages<1||maxPages>1000)throw Error('城市刷新预算无效');
 const context=await loadCompanyContext(),file=recruitmentFile(mode),previous=JSON.parse(await fs.readFile(file,'utf8'));
 const selected=selectQueryCompanies(context,{mode,industry_filters:industries||['all'],company_filters:only||[]},{applyCities:false}).companies;
 const folder=path.resolve(out||path.join(CORE_ROOT,'state','city-refresh',mode,stamp())),byId=new Map(previous.companies.map(c=>[c.company_id,c]));
 await fs.mkdir(folder,{recursive:true});await writeJson(path.join(folder,'index-before.json'),previous);
 await mapLimit(selected,concurrency,async source=>{
  const resultFile=path.join(folder,source.company_id+'.json'),fingerprint=sourceConfigFingerprint(source,mode);let result;
  if(resume)try{const old=JSON.parse(await fs.readFile(resultFile,'utf8'));if(old.source_config_fingerprint===fingerprint&&old.coverage.status==='complete')result=old;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!result){try{result=await collectCompanySources(source,{targetMode:mode,mode:'list',maxPages,maxDetails:20,timeoutMs:20000,repair:false,evidenceDir:path.join(folder,source.company_id),requestBudget:{remaining:180},signal:AbortSignal.timeout(60000)});}catch(e){result={jobs:[],coverage:{status:'failed',reason:e.message}};}
   result.jobs=result.jobs.map(j=>normalizeRetrievedJob(j,source,mode));result.source_config_fingerprint=fingerprint;await writeJson(resultFile,result);}
  byId.set(source.company_id,refreshedCityTag(source,result,byId.get(source.company_id),{mode,fingerprint,resultFile}));
 });
 // Compare exact input bytes before publication; never replace a concurrent refresh.
 const lock=await fs.open(file+'.lock','wx');
 try{
  const current=JSON.parse(await fs.readFile(file,'utf8'));if(JSON.stringify(current)!==JSON.stringify(previous))throw Error('城市索引已被其他任务更新，保留证据后重新执行');
  const index={...previous,updated_at:new Date().toISOString(),companies:context.registry.companies.map(c=>byId.get(c.company_id)||{company_id:c.company_id,cities:[],city_coverage_complete:false})};
  await writeJson(file,index);return {city_index:file,directory:folder,refreshed:selected.length};
 }finally{await lock.close();await fs.unlink(file+'.lock');}
}
export async function main(args=process.argv.slice(2)){
 const f={};for(let i=0;i<args.length;i++){const [k,v]=args[i].replace(/^--/,'').split('=');f[k]=v??(args[i+1]&&!args[i+1].startsWith('--')?args[++i]:true);}
 return refreshCities({mode:f.mode,only:f.only?String(f.only).split(','):undefined,industries:f.industries?String(f.industries).split(','):undefined,out:f.out,resume:!!f.resume,concurrency:Number(f.concurrency||2),maxPages:Number(f['max-pages']||100)});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
