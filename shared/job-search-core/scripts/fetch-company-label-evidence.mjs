import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {PACK_ROOT} from '../runtime-context.mjs';

const flags=Object.fromEntries(process.argv.slice(2).map(arg=>{const [key,...value]=arg.replace(/^--/,'').split('=');return [key,value.join('=')||true];}));
const input=path.resolve(flags.input||''),out=path.resolve(flags.out||path.join(path.dirname(input),'fetch'));
const concurrency=Math.max(1,Math.min(8,Number(flags.concurrency||4))),limit=Number(flags.limit||Infinity);
const allowedRoot=path.join(PACK_ROOT,'shared/job-search-core/state/maintenance');
for(const directory of [input,out]){const relative=path.relative(allowedRoot,directory);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('input/out must be below shared/job-search-core/state/maintenance');}
const mcporterCli='C:\\Users\\11793\\AppData\\Roaming\\npm\\node_modules\\mcporter\\dist\\cli.js';
const exaKey=process.env.EXA_API_KEY||'';
const redact=value=>String(value||'').replaceAll(exaKey||'__NO_KEY__','[REDACTED]');
const exaArgs=(tool,payload,timeout)=>exaKey
  ?[mcporterCli,'call','--http-url',`https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(exaKey)}`,'--tool',tool,'--args',JSON.stringify(payload),'--output','json','--timeout',String(timeout)]
  :[mcporterCli,'call',`exa.${tool}`,'--args',JSON.stringify(payload),'--output','json','--timeout',String(timeout)];
const rejectedHosts=/(^|\.)(qcc|tianyancha|baidu|sohu|sina|163|zhihu|douban|jobui|kanzhun|zhipin|liepin|zhaopin|51job|simuwang|bosszhipin)\./i;
const atsHosts=/(mokahr|zhiye|hotjob|feishu|workdayjobs|myworkdayjobs|greenhouse|smartrecruiters|jobs2web|successfactors|oraclecloud|avature|icims)/i;
const authoritativeHosts=/(^|\.)(gov\.cn|sasac\.gov\.cn|sse\.com\.cn|szse\.cn|cninfo\.com\.cn|amac\.org\.cn)$/i;
const normalize=value=>(value||'').toLowerCase().replace(/[\s（）()·・,，.。\-—_有限公司集团股份控股中国]/g,'');
const parseResults=text=>text.split(/\n---\n/).map(block=>({title:block.match(/^Title:\s*(.*)$/m)?.[1]?.trim()||'',url:block.match(/^URL:\s*(https?:\/\/\S+)/m)?.[1]?.trim()||'',text:block})).filter(item=>item.url);
function candidates(record){
  const text=record.response?.content?.filter(item=>item.type==='text').map(item=>item.text).join('\n')||'';
  const name=normalize(record.display_name),ranked=[];
  for(const item of parseResults(text)){
    let host;try{host=new URL(item.url).hostname.toLowerCase();}catch{continue;}
    if(rejectedHosts.test(host)||atsHosts.test(host))continue;
    const body=normalize(item.title+' '+item.text.slice(0,1200));
    const entityMatch=name.length>=3&&(body.includes(name)||name.includes(body.slice(0,Math.min(body.length,10))));
    const authority=authoritativeHosts.test(host)||host.endsWith('.gov.cn');
    ranked.push({...item,host,entity_match:entityMatch,authority,score:(authority?3:0)+(entityMatch?2:0)});
  }
  ranked.sort((a,b)=>b.score-a.score);
  const selected=[];
  for(const item of ranked){if(selected.some(row=>row.host===item.host))continue;if(!item.entity_match&&!item.authority)continue;selected.push(item);if(selected.length===2)break;}
  return selected;
}
const save=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});const temporary=file+`.${process.pid}.tmp`;await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n');await fs.rename(temporary,file);};
function fetchUrls(urls){
  const args=exaArgs('web_fetch_exa',{urls,maxCharacters:12000},60000);
  return new Promise(resolve=>{const child=spawn(process.execPath,args,{cwd:PACK_ROOT,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',error=>resolve({ok:false,error:redact(error)}));child.once('exit',code=>{if(code!==0)return resolve({ok:false,error:redact(stderr.trim()||`exit_${code}`)});try{const response=JSON.parse(stdout);if(response?.error)return resolve({ok:false,error:redact(response.error),issue:response.issue?JSON.parse(redact(JSON.stringify(response.issue))):null});resolve({ok:true,response});}catch(error){resolve({ok:false,error:`invalid_json: ${error.message}`,raw:redact(stdout.slice(0,2000))});}});});
}

const files=(await fs.readdir(input)).filter(file=>file.endsWith('.json')).slice(0,limit);await fs.mkdir(out,{recursive:true});
let cursor=0,completed=0,succeeded=0,failed=0,noCandidate=0,skipped=0;
async function worker(){while(cursor<files.length){const file=files[cursor++],target=path.join(out,file);try{const existing=JSON.parse(await fs.readFile(target,'utf8'));if(existing.ok&&!existing.response?.error){skipped++;completed++;continue;}}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  const search=JSON.parse(await fs.readFile(path.join(input,file),'utf8')),selected=candidates(search);let result;
  if(!selected.length){result={ok:false,error:'no_trusted_candidate'};noCandidate++;}
  else{result=await fetchUrls(selected.map(item=>item.url));if(!result.ok){await new Promise(resolve=>setTimeout(resolve,1500));result=await fetchUrls(selected.map(item=>item.url));}}
  const record={schema_version:1,company_id:search.company_id,display_name:search.display_name,industry_tags:search.industry_tags,business_state:search.business_state,ownership_missing:search.ownership_missing,searched_at:search.searched_at,fetched_at:new Date().toISOString(),selected_urls:selected.map(({title,url,host,entity_match,authority})=>({title,url,host,entity_match,authority})),...result};
  await save(target,record);completed++;if(result.ok)succeeded++;else if(result.error!=='no_trusted_candidate')failed++;if(completed%25===0)console.log(JSON.stringify({total:files.length,completed,succeeded,failed,no_candidate:noCandidate,skipped,remaining:files.length-completed}));
}}
await Promise.all(Array.from({length:concurrency},worker));const summary={schema_version:1,completed_at:new Date().toISOString(),total:files.length,completed,succeeded,failed,no_candidate:noCandidate,skipped};await save(path.join(path.dirname(out),'fetch-summary.json'),summary);console.log(JSON.stringify(summary));
