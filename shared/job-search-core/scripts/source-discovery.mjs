import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createClient} from './lib/http.mjs';
import {collectCommon} from './lib/providers-common.mjs';
import {reviewJobBody} from './lib/body-review.mjs';
import {reviewRecruitment} from './lib/recruitment-policy.mjs';
import {workspacePath} from './lib/io.mjs';
import {zeroJobCapability} from './lib/waiqi-zero-source-policy.mjs';
import {runtimeContext,configureRuntime} from '../runtime-context.mjs';

const json=async(f,v)=>{await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,JSON.stringify(v,null,2)+'\n');};
const decode=s=>String(s).replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
export const idFor=name=>'company-'+createHash('sha256').update(name).digest('hex').slice(0,12);
export function sourceFromEntry(item,entry,{allTypes=false}={}) {
  const u=new URL(entry);u.hash='';
  for(const key of [...u.searchParams.keys()])if(/token|session|spread|^code$|^state$|channelcode/i.test(key))u.searchParams.delete(key);
  entry=u.href;
  let provider,url,body,detailUrl;
  let headers={'Content-Type':'application/json',Origin:u.origin,Referer:entry};
  const moka=u.pathname.match(/\/(campus_apply|campus-recruitment|social-recruitment|apply)\/([^/]+)\/(\d+)/i);
  const su=entry.match(/SU[\da-f]{24}/i)?.[0];
  if(moka) {
    provider='moka';url=u.origin+'/api/outer/ats-apply/website/jobs/v2';
    body={orgId:moka[2],siteId:moka[3],site:moka[1],locale:'zh-CN',limit:50,offset:0,needStat:true};
    detailUrl=u.origin+'/api/outer/ats-apply/website/job';
  }else if(/\.zhiye\.com$/.test(u.hostname)||item.provider==='beisen') {
    provider='beisen';headers.Referer=entry;
    url=u.origin+'/api/Jobad/GetJobAdPageList';body={PageIndex:0,PageSize:50,KeyWords:'',SpecialType:0,PortalId:'',Category:allTypes?[]:['2']};
    headers={...headers,'X-Requested-With':'XMLHttpRequest',langType:'zh_CN'};detailUrl=u.origin+'/api/JobAd/GetJobAdInfo';
  }else if(/\.jobs\.(?:feishu\.cn|f\.mioffice\.cn)$/.test(u.hostname)||item.provider==='feishu') {
    provider='feishu';let channel=u.pathname.split('/').filter(Boolean)[0]||'index';
    if(channel==='referral')channel=u.pathname.split('/').filter(Boolean)[1]||'index';
    entry=u.origin+'/'+channel;headers={...headers,Referer:entry,'portal-channel':'saas-career','portal-platform':'pc','website-path':channel};
    url=u.origin+'/api/v1/search/job/posts';body={keyword:'',limit:50,offset:0,portal_type:3,portal_entrance:1,language:'zh',recruitment_id_list:allTypes?[]:['201']};
    detailUrl=u.origin+'/api/v1/job/posts/{job_id}';
  }else if(su) {
    provider='hotjob';url=u.origin+'/wecruit/positionInfo/listPosition/'+su+'?iSaJAx=isAjax&request_locale=zh_CN';
    body='isFrompb=true&recruitType='+(allTypes?'2':'1')+'&pageSize=15&currentPage=1';headers['Content-Type']='application/x-www-form-urlencoded';
    detailUrl=url.replace('/listPosition/','/listPositionDetail/');
  }else throw Error('No supported ATS configuration in observed entry URL');
  const source={company_id:item.company_id||idFor(item.display_name),display_name:item.display_name,provider,category:item.category||'待确认细分行业',primary_entry_url:entry,
    validated_api_request_examples:[{url,method:'POST',headers,body,purpose:'job_list'},{url:detailUrl,method:provider==='beisen'||provider==='feishu'?'GET':'POST',headers,body:null,purpose:'job_detail'}],
    public_bootstrap_requests:provider==='feishu'?[{url:u.origin+'/api/v1/csrf/token',method:'POST',headers,body:{portal_entrance:1},purpose:'public_csrf_bootstrap'}]:[{url:entry,method:'GET',purpose:'public_configuration_bootstrap'}]};
  return source;
}

export async function discoverEntry(item,entry,folder) {
  try{return {source:sourceFromEntry(item,entry),discovery:[]};}catch{}
  const client=createClient({evidenceDir:path.join(folder,'discovery-http'),timeoutMs:10000});
  const r=await client.request({url:entry},{purpose:'official_portal_discovery'});
  await json(path.join(folder,'discovery-requests.json'),client.records);
  if(r.record.http_status!==200)throw Error('Portal discovery HTTP '+r.record.http_status);
  try{return {source:sourceFromEntry(item,r.url),discovery:client.records};}catch{}
  if(/feishucdn.*atsx|atsx-throne|saas-career/i.test(r.text))return {source:sourceFromEntry({...item,provider:'feishu'},r.url),discovery:client.records};
  if(/bstatics\.com|ux-recruitment-portal|beisen/i.test(r.text))return {source:sourceFromEntry({...item,provider:'beisen'},r.url),discovery:client.records};
  if(/hotjob\.cn|wecruit|\/common\/getSLD/i.test(r.text)){
    try{
      const base=new URL(r.url);const boot=await client.request({url:base.origin+'/wecruit/common/getSLD',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Referer:r.url},body:'sld='+encodeURIComponent(base.hostname)},{purpose:'public_hotjob_domain_configuration'});
      await json(path.join(folder,'discovery-requests.json'),client.records);
      const link=boot.data?.data?.linkData?.link||boot.data?.data?.link||boot.data?.linkData?.link;
      if(typeof link==='string')return {source:sourceFromEntry(item,new URL(link,r.url).href),discovery:client.records};
    }catch{}
  }
  const html=decode(r.text),links=[...html.matchAll(/(?:https?:)?\/\/[^\s"'<>\\]+(?:mokahr\.com|zhiye\.com|hotjob\.cn|jobs\.feishu\.cn)[^\s"'<>\\]*/g)].map(m=>m[0]);
  // Only follow recruitment links actually present in the public page, never search company-specific tenant IDs by guess.
  for(const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi))if(/campus-recruitment|campus_apply|zhiye\.com|jobs\.feishu\.cn|SU[\da-f]{24}/i.test(m[1]))links.push(new URL(m[1],r.url).href);
  const input=[...r.text.matchAll(/<input\b[^>]*>/gi)].find(m=>/\bid\s*=\s*["']init-data["']/i.test(m[0]));
  if(input){try{const cfg=JSON.parse(decode(input[0].match(/\bvalue\s*=\s*(["'])([\s\S]*?)\1/i)[2]));const org=cfg.org?.subdomain||cfg.org?.orgId||cfg.orgId;const site=cfg.org?.siteId||cfg.siteId;if(org&&site)links.unshift(new URL('/'+(cfg.org?.type==='social'?'social-recruitment':'campus-recruitment')+'/'+org+'/'+site,r.url).href);}catch{}}
  const su=html.match(/SU[\da-f]{24}/i)?.[0];if(su)links.unshift(new URL('/'+su+'/pb/school.html',r.url).href);
  for(let link of [...new Set(links)]){if(link.startsWith('//'))link='https:'+link;try{const target=new URL(link);if(/^(portal-oss|static|cdn|img|image|assets)\./i.test(target.hostname)||/\.(?:js|css|png|jpg|svg|woff2?)(?:$|\?)/i.test(target.pathname))continue;return {source:sourceFromEntry(item,link),discovery:client.records};}catch{}}
  throw Error('Public page retrieved; API configuration still needs targeted discovery');
}

export async function verifyCandidate(item,outputDir,options={}) {
  const targetMode=options.targetMode||runtimeContext().mode;if(!targetMode)throw Error('来源核验需要明确招聘方向');
  const folder=path.join(outputDir,item.company_id||idFor(item.display_name));await fs.mkdir(folder,{recursive:true});
  const entries=[...new Set(item.entry_urls||item.endpoints?.map(e=>e.url_canonical||e.url_sample)||[])];
  const attempts=[],seenContexts=new Set();let best=null;
  const prefer=a=>{if(!best||a.formal_jobs>best.formal_jobs||(a.formal_jobs===best.formal_jobs&&a.complete_jds>best.complete_jds)
    ||(a.formal_jobs===best.formal_jobs&&a.complete_jds===best.complete_jds&&!!a.zero_job_capability>!!best.zero_job_capability))best=a;};
  for(let index=0;index<entries.length;index++){
    const attemptDir=path.join(folder,'attempt-'+(index+1));
    try {
      const endpoint=item.endpoints?.find(e=>[e.url_canonical,e.url_sample].includes(entries[index]));
      const providerHint=({feishu_recruitment:'feishu',beisen:'beisen',moka:'moka',hotjob:'hotjob'})[endpoint?.provider];
      const {source,discovery}=await discoverEntry({...item,...providerHint?{provider:providerHint}:{}},entries[index],attemptDir);
      const q=source.validated_api_request_examples[0];const contextKey=JSON.stringify([source.provider,q.url,q.body,q.headers?.['website-path']]);
      if(seenContexts.has(contextKey))continue;seenContexts.add(contextKey);
      const settings={mode:'full',targetMode,pageSize:50,maxPages:100,timeoutMs:15000,...options,evidenceDir:path.join(attemptDir,'http')};
      const result=await collectCommon(source,settings);result.jobs=result.jobs.map(j=>reviewRecruitment(reviewJobBody(j),targetMode));await json(path.join(attemptDir,'source.json'),source);await json(path.join(attemptDir,'result.json'),result);
      const complete=result.jobs.filter(j=>j.body_complete&&j.job_id&&j.official_url);
      const zero=result.jobs.length===0?zeroJobCapability(source,result).capability:null;
      const attempt={entry_url:source.primary_entry_url,provider:source.provider,source_file:path.join(attemptDir,'source.json'),result_file:path.join(attemptDir,'result.json'),jobs:result.jobs.length,complete_jds:complete.length,
        formal_jobs:result.jobs.filter(j=>j.body_complete&&j.formal_status===(targetMode==='campus'?'formal':targetMode)&&j.open_status==='open').length,coverage:result.coverage,discovery_requests:discovery,...(zero?{zero_job_capability:zero}:{})};
      attempts.push(attempt);prefer(attempt);
      if(complete.length)continue;
      if(result.coverage.pages&&['beisen','feishu','hotjob'].includes(source.provider)){
        const broad=sourceFromEntry({...item,provider:source.provider},source.primary_entry_url,{allTypes:true});
        const cap=await collectCommon(broad,{...settings,maxPages:2,evidenceDir:path.join(attemptDir,'capability-http')});cap.jobs=cap.jobs.map(j=>reviewRecruitment(reviewJobBody(j),targetMode));
        await json(path.join(attemptDir,'capability-source.json'),broad);await json(path.join(attemptDir,'capability-result.json'),cap);
        const caps=cap.jobs.filter(j=>j.body_complete&&j.job_id&&j.official_url);
        if(caps.length){const proof={...attempt,capability_source_file:path.join(attemptDir,'capability-source.json'),capability_result_file:path.join(attemptDir,'capability-result.json'),complete_jds:caps.length,capability_only:true,capability_coverage:cap.coverage};attempts[attempts.length-1]=proof;prefer(proof);}
      }
    }catch(error){attempts.push({entry_url:entries[index],error:error.message});}
  }
  const row={...item,company_id:item.company_id||idFor(item.display_name),checked_at:new Date().toISOString(),...best,attempts,verified_sources:attempts.filter(a=>a.complete_jds>0),zero_job_api_sources:attempts.filter(a=>a.zero_job_capability),
    admitted:!!best?.complete_jds,state:best?.complete_jds?'verified_api_full_jd':best?.zero_job_capability?'verified_api_zero_jobs_pending_identity':best?.coverage?.pages?'empty_or_incomplete_api':'unverified',reason:best?.coverage?.reason||attempts.at(-1)?.error||'No entry URLs available'};
  await json(path.join(folder,'verification.json'),row);return row;
}

export async function main(argv=process.argv.slice(2)){
  const [input,output,...rest]=argv;if(!input||!output)throw Error('Usage: node discover-and-verify.mjs candidates.json output-dir [--max-pages=N] [--concurrency=N] [--refresh]');
  if(!runtimeContext().mode)configureRuntime({mode:rest.find(a=>a.startsWith('--mode='))?.slice(7)});
  const items=JSON.parse(await fs.readFile(input,'utf8'));const folder=workspacePath(path.resolve(output));await fs.mkdir(folder,{recursive:true});
  const get=(key,def)=>Number(rest.find(x=>x.startsWith('--'+key+'='))?.split('=')[1]||def);const options={maxPages:get('max-pages',100),pageSize:get('page-size',50),timeoutMs:get('timeout-ms',15000)};
  const rows=[];let cursor=0;await Promise.all(Array.from({length:get('concurrency',3)},async()=>{while(cursor<items.length){const item=items[cursor++];let row;
    const saved=path.join(folder,item.company_id||idFor(item.display_name),'verification.json');
    if(!rest.includes('--refresh'))try{row=JSON.parse(await fs.readFile(saved,'utf8'));}catch{}
    row ||= await verifyCandidate(item,folder,options);rows.push(row);console.log(JSON.stringify({name:row.display_name,state:row.state,jobs:row.jobs,full:row.complete_jds,formal:row.formal_jobs,reason:row.reason}));
  }}));await json(path.join(folder,'manifest.json'),rows.sort((a,b)=>items.findIndex(c=>c.display_name===a.display_name)-items.findIndex(c=>c.display_name===b.display_name)));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
