import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {PACK_ROOT} from '../runtime-context.mjs';

const [workArg,...rawArgs]=process.argv.slice(2);
const options=Object.fromEntries(rawArgs.map(arg=>{const [key,...values]=arg.replace(/^--/,'').split('=');return [key,values.join('=')||true];}));
if(!workArg)throw Error('用法：search-fresh-company-review.mjs 工作目录 [--limit=25] [--concurrency=2]');
const root=path.resolve(workArg),artifactRoot=path.join(PACK_ROOT,'shared','job-search-core','state','maintenance'),relative=path.relative(artifactRoot,root);
if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('工作目录必须位于 shared/job-search-core/state/maintenance');
const campaign=JSON.parse(await fs.readFile(path.join(root,'campaign.json'),'utf8'));
const limit=Math.max(1,Math.min(3220,Number(options.limit||25))),concurrency=Math.max(1,Math.min(3,Number(options.concurrency||2)));
const searchDirectory=path.join(root,'search');await fs.mkdir(searchDirectory,{recursive:true});
const mcporterCli='C:\\Users\\11793\\AppData\\Roaming\\npm\\node_modules\\mcporter\\dist\\cli.js';
const save=async(file,value)=>{const temp=file+`.${process.pid}.tmp`;await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n');await fs.rename(temp,file);};
const search=company=>new Promise(resolve=>{
  // The request contains identity anchors only. It deliberately has no old tags, ownership, or descriptions.
  const query=`${company.display_name} 官方 公司简介 主营业务 产品 服务 股东 控制人 上市`;
  const child=spawn(process.execPath,[mcporterCli,'call','exa.web_search_exa','--args',JSON.stringify({query,numResults:5}),'--output','json','--timeout','45000'],{cwd:PACK_ROOT,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);
  child.once('error',error=>resolve({status:'failed',query,error:error.message,result_urls:[],raw:''}));
  child.once('exit',code=>{
    const urls=[...stdout.matchAll(/https?:\/\/[^\s"'\])}]+/g)].map(match=>match[0].replace(/[),.;]+$/,''));
    let serviceError='';
    try {serviceError=JSON.parse(stdout).error||'';} catch {}
    resolve(code===0&&!serviceError?{status:'success',query,result_urls:[...new Set(urls)],raw:stdout}:{status:'failed',query,error:serviceError||stderr.trim()||`exit_${code}`,result_urls:[...new Set(urls)],raw:stdout});
  });
});
const reviewed=new Set();try{for(const file of await fs.readdir(path.join(root,'reviews')))if(file.endsWith('.json'))reviewed.add(file.slice(0,-5));}catch{}
const queue=[];
for(const company of campaign.companies){
  if(reviewed.has(company.company_id))continue;
  try {const old=JSON.parse(await fs.readFile(path.join(searchDirectory,company.company_id+'.json'),'utf8'));if(old.campaign_id===campaign.campaign_id&&old.status==='success'&&!String(old.raw||'').includes('"error"'))continue;}catch{}
  queue.push(company);if(queue.length===limit)break;
}
let cursor=0,done=0,success=0,failed=0;
async function worker(){while(cursor<queue.length){const company=queue[cursor++],result=await search(company),record={schema_version:1,campaign_id:campaign.campaign_id,company_id:company.company_id,display_name:company.display_name,aliases:company.aliases||[],recruitment_urls:company.recruitment_urls||[],searched_at:new Date().toISOString(),tool:'agent-reach/exa.web_search_exa',...result};await save(path.join(searchDirectory,company.company_id+'.json'),record);done++;if(result.status==='success')success++;else failed++;console.log(JSON.stringify({company_id:company.company_id,display_name:company.display_name,status:result.status,urls:record.result_urls.length,done,total:queue.length}));}}
await Promise.all(Array.from({length:concurrency},worker));
console.log(JSON.stringify({campaign_id:campaign.campaign_id,attempted:queue.length,success,failed,remaining:campaign.companies.length-reviewed.size-(await fs.readdir(searchDirectory)).filter(file=>file.endsWith('.json')).length}));
