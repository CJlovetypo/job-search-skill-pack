import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {PACK_ROOT} from '../runtime-context.mjs';
import {SOURCE_REGISTRY_FILE, COMPANY_BUSINESS_FILE, COMPANY_OWNERSHIP_FILE} from '../registry.mjs';

const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const save=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});const temporary=file+`.${process.pid}.tmp`;await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n');await fs.rename(temporary,file);};
const flags=Object.fromEntries(process.argv.slice(2).map(arg=>{const [key,...value]=arg.replace(/^--/,'').split('=');return [key,value.join('=')||true];}));
const scope=flags.scope||'business-missing',concurrency=Math.max(1,Math.min(8,Number(flags.concurrency||4))),limit=Number(flags.limit||Infinity);
if(!['business-missing','business-partial','ownership','all'].includes(scope))throw Error('scope must be business-missing, business-partial, ownership or all');
const out=path.resolve(flags.out||path.join(PACK_ROOT,'shared/job-search-core/state/maintenance/company-label-research-20260922',scope));
const allowedRoot=path.join(PACK_ROOT,'shared/job-search-core/state/maintenance'),relative=path.relative(allowedRoot,out);
if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('out must be below shared/job-search-core/state/maintenance');
const mcporterCli='C:\\Users\\11793\\AppData\\Roaming\\npm\\node_modules\\mcporter\\dist\\cli.js';
const exaKey=process.env.EXA_API_KEY||'';
const redact=value=>String(value||'').replaceAll(exaKey||'__NO_KEY__','[REDACTED]');
const exaArgs=(tool,payload,timeout)=>exaKey
  ?[mcporterCli,'call','--http-url',`https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(exaKey)}`,'--tool',tool,'--args',JSON.stringify(payload),'--output','json','--timeout',String(timeout)]
  :[mcporterCli,'call',`exa.${tool}`,'--args',JSON.stringify(payload),'--output','json','--timeout',String(timeout)];

const [registry,business,ownership]=await Promise.all([read(SOURCE_REGISTRY_FILE),read(COMPANY_BUSINESS_FILE),read(COMPANY_OWNERSHIP_FILE)]);
const byBusiness=new Map(business.companies.map(row=>[row.company_id,row])),byOwnership=new Map(ownership.companies.map(row=>[row.company_id,row]));
const hasEvidence=row=>row?.evidence?.some(item=>/^https?:\/\//.test(item.url||'')&&item.title&&item.note&&item.checked_at);
const businessState=company=>{const row=byBusiness.get(company.company_id);return row?.status==='verified'&&hasEvidence(row)?'verified':row?.business_tags?.length?'partial':'missing';};
const ownershipMissing=company=>!['verified','verified_unresolved'].includes(byOwnership.get(company.company_id)?.status);
let queue=registry.companies.filter(company=>scope==='business-missing'?businessState(company)==='missing':scope==='business-partial'?businessState(company)==='partial':scope==='ownership'?ownershipMissing(company):businessState(company)!=='verified'||ownershipMissing(company));
queue=queue.slice(0,limit);
await fs.mkdir(path.join(out,'search'),{recursive:true});

function search(company){
  const needsOwnership=ownershipMissing(company),needsBusiness=businessState(company)!=='verified';
  const query=`${company.display_name} 官方 ${needsBusiness?'公司简介 主营业务 产品 服务':''} ${needsOwnership?'公司性质 国有 民营 外资 股东 控制人':''}`.replace(/\s+/g,' ').trim();
  const objective=`定位“${company.display_name}”对应招聘主体的第一方官网、官方公司介绍、产品服务页，以及政府、国资监管、交易所或行业监管机构资料。${needsBusiness?'提取主体明确提供的产品或服务；':''}${needsOwnership?'提取能够证明国有控制、民营控制、外资控制或无法归入企业所有制的原文；':''}排除招聘聚合站、百科、营销软文和仅有搜索摘要但无法打开的页面。`;
  const args=exaArgs('web_search_exa',{query,numResults:5,objective},45000);
  return new Promise(resolve=>{
    const child=spawn(process.execPath,args,{cwd:PACK_ROOT,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.once('error',error=>resolve({ok:false,error:redact(error),query,objective}));
    child.once('exit',code=>{if(code!==0)return resolve({ok:false,error:redact(stderr.trim()||`exit_${code}`),query,objective});try{const response=JSON.parse(stdout);if(response?.error)return resolve({ok:false,error:redact(response.error),issue:response.issue?JSON.parse(redact(JSON.stringify(response.issue))):null,query,objective});resolve({ok:true,query,objective,response});}catch(error){resolve({ok:false,error:`invalid_json: ${error.message}`,query,objective,raw:redact(stdout.slice(0,2000))});}});
  });
}

let cursor=0,completed=0,succeeded=0,failed=0,skipped=0;
const startedAt=new Date().toISOString();
async function worker(){
  while(cursor<queue.length){
    const company=queue[cursor++],file=path.join(out,'search',company.company_id+'.json');
    try{const existing=JSON.parse(await fs.readFile(file,'utf8'));if(existing.ok&&!existing.response?.error){skipped++;completed++;continue;}}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
    let result=await search(company);
    if(!result.ok){await new Promise(resolve=>setTimeout(resolve,1500));result=await search(company);}
    const record={schema_version:1,company_id:company.company_id,display_name:company.display_name,industry_tags:company.industry_tags||[],business_state:businessState(company),ownership_missing:ownershipMissing(company),searched_at:new Date().toISOString(),...result};
    await save(file,record);completed++;if(result.ok)succeeded++;else failed++;
    if(completed%25===0)console.log(JSON.stringify({scope,total:queue.length,completed,succeeded,failed,skipped,remaining:queue.length-completed}));
  }
}
await Promise.all(Array.from({length:concurrency},worker));
const summary={schema_version:1,scope,started_at:startedAt,completed_at:new Date().toISOString(),total:queue.length,completed,succeeded,failed,skipped};
await save(path.join(out,'search-summary.json'),summary);console.log(JSON.stringify(summary));
