import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {collectJobs2web} from './lib/provider-jobs2web.mjs';
import {collectAjinga} from './lib/provider-ajinga.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createClient} from './lib/http.mjs';
import {sourceFromEntry} from './source-discovery.mjs';
import {collectCommon} from './lib/providers-common.mjs';

const DEFAULT_INPUT=path.resolve('datasets/recruitment-links/catalog/waiqi-source-candidates.json');
const publicCareerHosts=new Set(JSON.parse(readFileSync(new URL('../assets/public-career-hosts.json',import.meta.url),'utf8')).hosts.map(x=>x.host));
const DEFAULT_OUTPUT=path.resolve('shared/job-search-core/state/maintenance/waiqi-2026-09-20/zero-position-official-discovery');
const locale=/^(?:en|en-us|en-gb|zh|zh-cn|zh-hans|de|fr|ja|ko)$/i;
const atsHost=/(?:myworkdayjobs\.com|myworkdaysite\.com|smartrecruiters\.com|greenhouse\.io|ashbyhq\.com|mokahr\.com|zhiye\.com|hotjob\.cn|jobs\.(?:feishu\.cn|f\.mioffice\.cn)|oraclecloud\.com|careers\.bissell\.com)$/i;
const isAtsHost=host=>atsHost.test(host)||publicCareerHosts.has(host.toLowerCase())||host.toLowerCase()==='www.ajinga.com';
const careerWords=/(?:career|careers|job|jobs|join[\s_-]*us|work[\s_-]*with[\s_-]*us|vacanc|opportunit|recruit|talent|招聘|招贤|人才|加入我们|工作机会|职位)/i;
const rejectAsset=/\.(?:js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map|pdf|zip)(?:$|[?#])/i;
const commonWords=new Set(['company','group','limited','ltd','china','chinese','international','global','holdings','technology','technologies','management','corporation','inc','shanghai','beijing','suzhou','guangzhou']);

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const json=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.tmp-'+process.pid;await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n');await fs.rename(temp,file);};
const safeId=value=>String(value).replace(/[^a-zA-Z0-9_-]/g,'_');
const decode=s=>String(s||'').replace(/\\\//g,'/').replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&#x2f;/gi,'/');
const text=s=>decode(s).replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();

export function normalizeWebsite(value){
  let raw=String(value||'').trim();
  if(!raw||/^www\.?$/i.test(raw))return null;
  if(!/^https?:\/\//i.test(raw))raw='https://'+raw;
  try{const u=new URL(raw);if(!u.hostname.includes('.')||u.username||u.password||!['http:','https:'].includes(u.protocol))return null;u.hash='';return u.href;}catch{return null;}
}

function identityEvidence(company,url,html){
  const hay=text(html).normalize('NFKC').toLowerCase().slice(0,500000),host=new URL(url).hostname.toLowerCase();
  const names=[company.display_name,...(company.aliases||[])].map(x=>String(x||'').normalize('NFKC').trim()).filter(Boolean);
  const exact=names.filter(n=>n.length>=4&&hay.includes(n.toLowerCase())).sort((a,b)=>b.length-a.length).slice(0,5);
  const latin=[...new Set(names.flatMap(n=>n.match(/[A-Za-z][A-Za-z0-9&.' -]{2,}/g)||[]).flatMap(n=>n.split(/\s+/)).map(x=>x.replace(/[^a-z0-9]/gi,'').toLowerCase()).filter(x=>x.length>=4&&!commonWords.has(x)))];
  const domain=host.split('.').filter(x=>!['www','careers','jobs','career','global','cn','com','net','org','co'].includes(x))[0]||'';
  const domainMatches=latin.filter(x=>x===domain||x.includes(domain)||domain.includes(x)).slice(0,5);
  return {confirmed:exact.length>0||domainMatches.length>0,exact_page_name_matches:exact,domain_alias_matches:domainMatches,page_final_url:url};
}

export function extractCareerLinks(base,html){
  const found=[];let order=0;
  const add=(raw,label='')=>{try{raw=decode(raw).trim().split(/["'<>\s]/,1)[0].replace(/[},;]+$/,'');if(raw.startsWith('//'))raw='https:'+raw;const u=new URL(raw,base);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||rejectAsset.test(u.pathname))return;const direct=isAtsHost(u.hostname);const career=careerWords.test(label+' '+u.pathname+' '+u.hostname);if(!direct&&!career)return;found.push({url:u.href,label:text(label).slice(0,160),direct_ats:direct,score:(direct?20:0)+(career?8:0)+(u.origin===new URL(base).origin?2:0),order:order++});}catch{}};
  for(const m of String(html).matchAll(/<a\b([^>]*)href\s*=\s*(["'])([\s\S]*?)\2([^>]*)>([\s\S]*?)<\/a>/gi))add(m[3],m[5]);
  const expanded=decode(String(html));
  for(const m of expanded.matchAll(/https?:\/\/[^\s"'<>\\]+/gi))try{if(isAtsHost(new URL(m[0]).hostname))add(m[0],'embedded ATS URL');}catch{/* Ignore malformed text that merely starts like a URL. */}
  return [...new Map(found.sort((a,b)=>b.score-a.score||a.order-b.order).map(x=>[x.url,x])).values()];
}

export function atsConfiguration(entry){
  let u;try{u=new URL(entry);}catch{return null;}const host=u.hostname.toLowerCase(),segments=u.pathname.split('/').filter(Boolean);
  if(host==='www.ajinga.com'){
    const id=u.pathname.match(/^\/(?:recruiting\/company|company-detail-new)\/(\d+)(?:\/|$)/)?.[1];
    if(id)return {provider:'ajinga_public',entry_url:'https://www.ajinga.com/recruiting/company/'+id+'/',api:{url:'https://www.ajinga.com/django_rest/job-list/?company_id='+id+'&page=1&page_size=100',method:'GET'},api_config:{company_id:id},capability:'public_list_only'};
  }
  if(publicCareerHosts.has(host))return {provider:'jobs2web_public',entry_url:u.origin+'/search/',api:{url:u.origin+'/search/?optionsFacetsDD_country=CN',method:'GET'},api_config:{origin:u.origin},capability:'public_list_only'};
  if(/^wd\d+\.myworkdaysite\.com$/.test(host)&&segments[0]==='recruiting'&&segments[1]&&segments[2]){
    const tenant=segments[1],site=segments[2];
    if(!/^[\w-]+$/.test(tenant)||!/^[\w-]+$/.test(site))return null;
    return {provider:'workday',entry_url:u.origin+'/recruiting/'+tenant+'/'+site,entry_kind:'alternate_recruiting_root',api:{url:u.origin+'/wday/cxs/'+tenant+'/'+site+'/jobs',method:'POST',body:{appliedFacets:{},limit:1,offset:0,searchText:''}},api_config:{origin:u.origin,tenant,site,public_path:'/recruiting/'+tenant+'/'+site}};
  }
  if(/\.myworkdayjobs\.com$/.test(host)){
    const tenant=host.split('.')[0],parts=segments.filter(x=>!locale.test(x)),reserved=/^(?:job|jobs|search|apply|userhome)$/i;let site,entry_kind;
    if(parts.length===1){site=parts[0];entry_kind='site_root';}
    else if(parts.length===2&&/^userhome$/i.test(parts[1])){site=parts[0];entry_kind='site_landing';}
    else if(parts[1]?.toLowerCase()==='job'){site=parts[0];entry_kind='job_detail';}
    else return null;
    if(!site||reserved.test(site))return null;
    return {provider:'workday',entry_url:u.href,entry_kind,api:{url:u.origin+'/wday/cxs/'+tenant+'/'+site+'/jobs',method:'POST',body:{appliedFacets:{},limit:1,offset:0,searchText:''}},api_config:{origin:u.origin,tenant,site}};
  }
  if(/(?:jobs|careers)\.smartrecruiters\.com$/.test(host)){
    const company_identifier=segments[0];if(!company_identifier)return null;
    return {provider:'smartrecruiters',entry_url:u.href,api:{url:'https://api.smartrecruiters.com/v1/companies/'+encodeURIComponent(company_identifier)+'/postings?limit=1&offset=0',method:'GET'},api_config:{company_identifier}};
  }
  if(/(?:boards|job-boards)\.greenhouse\.io$/.test(host)){
    const board_token=u.searchParams.get('for')||segments.find(x=>!locale.test(x)&&!['embed','jobs','job_board','js'].includes(x.toLowerCase()));if(!board_token)return null;
    return {provider:'greenhouse',entry_url:'https://job-boards.greenhouse.io/'+encodeURIComponent(board_token),api:{url:'https://boards-api.greenhouse.io/v1/boards/'+encodeURIComponent(board_token)+'/jobs?content=false',method:'GET'},api_config:{board_token}};
  }
  if(host==='jobs.ashbyhq.com'&&segments[0]){
    const board_token=decodeURIComponent(segments[0]);
    return {provider:'ashby',entry_url:'https://jobs.ashbyhq.com/'+encodeURIComponent(board_token),api:{url:'https://api.ashbyhq.com/posting-api/job-board/'+encodeURIComponent(board_token),method:'GET'},api_config:{board_token}};
  }
  if(host.endsWith('.tupu360.com')){
    const origin=u.origin;
    return {provider:'tupu360',entry_url:origin+'/position/list?type=SOCIALRECRUITMENT&lang=zh_CN',api:{url:origin+'/positionData/listInfo?type=SOCIALRECRUITMENT&offset=0&max=200&lang=zh_CN',method:'GET'},api_config:{origin}};
  }
  if(host==='careers.bissell.com'&&segments[0]==='jobs'){
    return {provider:'icims_jibe',entry_url:u.href,api:{url:u.origin+'/api/jobs?limit=100&offset=0&lang=en-US',method:'GET'},api_config:{origin:u.origin,language:'en-US'}};
  }
  const oracle=segments.findIndex(x=>x.toLowerCase()==='sites');
  if(/\.oraclecloud\.com$/.test(host)&&oracle>=0&&segments[oracle+1]){
    const site=segments[oracle+1];return {provider:'oracle_recruiting',entry_url:u.href,api:{url:u.origin+'/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber='+encodeURIComponent(site)+',facetsList=NONE,limit=1,offset=0',method:'GET'},api_config:{origin:u.origin,site}};
  }
  try{const source=sourceFromEntry({company_id:'discovery',display_name:'discovery'},u.href,{allTypes:true});return {provider:source.provider,entry_url:u.href,api:source.validated_api_request_examples[0],source};}catch{return null;}
}

function responseValid(config,response){
  const d=response.data;if(response.record.http_status!==200||!d)return {ok:false,reason:'HTTP '+response.record.http_status+' or non-JSON response'};
  if(config.provider==='workday')return {ok:Array.isArray(d.jobPostings)&&Number.isFinite(Number(d.total)),reported_jobs:Number(d.total),reason:'jobPostings array and numeric total'};
  if(config.provider==='smartrecruiters')return {ok:Array.isArray(d.content)&&Number.isFinite(Number(d.totalFound)),reported_jobs:Number(d.totalFound),reason:'content array and numeric totalFound'};
  if(config.provider==='greenhouse')return {ok:Array.isArray(d.jobs),reported_jobs:Array.isArray(d.jobs)?d.jobs.length:null,reason:'jobs array'};
  if(config.provider==='ashby')return {ok:Array.isArray(d.jobs),reported_jobs:Array.isArray(d.jobs)?d.jobs.length:null,reason:'jobs array'};
  if(config.provider==='icims_jibe')return {ok:Array.isArray(d.jobs)&&Number.isFinite(Number(d.totalCount)),reported_jobs:Number(d.totalCount),reason:'jobs array and numeric totalCount'};
  if(config.provider==='oracle_recruiting'){const item=d.items?.[0];return {ok:Array.isArray(item?.requisitionList)&&Number.isFinite(Number(item?.TotalJobsCount)),reported_jobs:Number(item?.TotalJobsCount),reason:'requisitionList and numeric TotalJobsCount'};}
  return {ok:true,reported_jobs:null,reason:'public provider JSON response; provider-specific collection follows'};
}

const hostNext=new Map();
async function gatedRequest(client,q,purpose,intervalMs){
  const host=new URL(q.url).hostname.toLowerCase();const now=Date.now(),next=hostNext.get(host)||0;if(next>now)await sleep(next-now);hostNext.set(host,Date.now()+intervalMs);
  return client.request(q,{purpose});
}

async function verify(config,companyDir,intervalMs){
  const client=createClient({evidenceDir:path.join(companyDir,'api-http'),timeoutMs:15000});
  try{
    if(['jobs2web_public','ajinga_public'].includes(config.provider)){
      const result=await (config.provider==='jobs2web_public'?collectJobs2web:collectAjinga)({...config,primary_entry_url:config.entry_url},{mode:'list',maxPages:100,timeoutMs:15000,client});
      return {ok:result.coverage.list_complete,reported_jobs:result.coverage.server_total,reason:result.coverage.reason,coverage:result.coverage,requests:result.requests};
    }
    if(['moka','beisen','feishu','hotjob'].includes(config.provider)){
      const result=await collectCommon(config.source,{mode:'list',maxPages:1,pageSize:1,maxDetails:0,detailConcurrency:1,timeoutMs:15000,evidenceDir:path.join(companyDir,'api-http')});
      const pages=Number(result?.coverage?.pages||0),reported=result?.coverage?.server_total;
      return {ok:pages>0,reported_jobs:Number.isFinite(Number(reported))?Number(reported):null,reason:result?.coverage?.reason||'provider collection',coverage:result?.coverage,requests:result?.requests||[]};
    }
    const response=await gatedRequest(client,config.api,'public_job_list_capability',intervalMs);return {...responseValid(config,response),requests:client.records};
  }catch(error){return {ok:false,reported_jobs:null,reason:error.message,requests:client.records};}
}

async function processCompany(company,output,options){
  const id=safeId(company.waiqi_company_id),dir=path.join(output,'companies',id),saved=path.join(dir,'result.json');
  if(!options.refresh)try{return JSON.parse(await fs.readFile(saved,'utf8'));}catch{}
  await fs.mkdir(dir,{recursive:true});const website=normalizeWebsite(company.website);
  const base={waiqi_company_id:company.waiqi_company_id,display_name:company.display_name,aliases:company.aliases||[],matched_company_ids:company.matched_company_ids||[],website_raw:company.website,website_normalized:website,checked_at:new Date().toISOString(),source_url:company.source_url};
  if(!website){const row={...base,state:'invalid_website',reason:'Website field is missing or not a usable HTTP(S) URL',discoveries:[],requests:[]};await json(saved,row);return row;}
  const client=createClient({evidenceDir:path.join(dir,'website-http'),timeoutMs:options.timeoutMs});let home;
  try{home=await gatedRequest(client,{url:website,headers:{Accept:'text/html,application/xhtml+xml'}},'supplier_website_homepage',options.intervalMs);}catch(error){const row={...base,state:'website_fetch_failed',reason:error.message,discoveries:[],requests:client.records};await json(saved,row);return row;}
  const identity=identityEvidence(company,home.url,home.text),links=extractCareerLinks(home.url,home.text),observed=[];
  for(const link of links.slice(0,options.followPages)){
    const direct=atsConfiguration(link.url);if(direct){observed.push({...link,observed_on:home.url,configuration:direct});continue;}
    try{const page=await gatedRequest(client,{url:link.url,headers:{Accept:'text/html,application/xhtml+xml'}},'official_career_link_follow',options.intervalMs);const finalConfig=atsConfiguration(page.url);if(finalConfig)observed.push({...link,observed_on:home.url,followed_url:page.url,configuration:finalConfig});
      for(const nested of extractCareerLinks(page.url,page.text).filter(x=>x.direct_ats).slice(0,5)){const configuration=atsConfiguration(nested.url);if(configuration)observed.push({...nested,observed_on:page.url,configuration});}
    }catch(error){observed.push({...link,observed_on:home.url,follow_error:error.message});}
  }
  const unique=[...new Map(observed.filter(x=>x.configuration).map(x=>[JSON.stringify([x.configuration.provider,x.configuration.api_config]),x])).values()];
  const discoveries=[];
  for(const found of unique.slice(0,options.maxAts)){
    const validation=await verify(found.configuration,dir,options.intervalMs);discoveries.push({provider:found.configuration.provider,entry_url:found.configuration.entry_url,api_config:found.configuration.api_config,api_request:found.configuration.api,official_chain:[home.url,found.observed_on,found.followed_url,found.configuration.entry_url].filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i),identity_evidence:identity,api_verified:validation.ok,reported_jobs:validation.reported_jobs,validation_reason:validation.reason,coverage:validation.coverage,api_requests:validation.requests});
  }
  const verified=discoveries.filter(x=>x.api_verified&&identity.confirmed);
  let state,reason;
  if(verified.length){state='verified_api_capability';reason='Official website chain, company identity and public ATS API all verified';}
  else if(discoveries.some(x=>x.api_verified)){state='api_verified_identity_review';reason='Public ATS API works, but page/domain identity needs entity review';}
  else if(discoveries.length){state='supported_ats_api_failed';reason='Supported ATS observed through website chain, but its public list API did not validate';}
  else if(links.length){state='career_link_found_no_supported_ats';reason='Official website exposed career links, but no supported ATS configuration was observed';}
  else {state='no_career_link_found';reason='Homepage returned, with no career link or supported ATS URL in the public HTML';}
  const row={...base,state,reason,homepage:{requested_url:website,final_url:home.url,http_status:home.record.http_status,response_sha256:home.record.response_sha256,response_file:home.record.response_file},identity_evidence:identity,career_links:links.slice(0,20),discoveries,requests:client.records};await json(saved,row);return row;
}

export async function main(args=process.argv.slice(2)){
  const flags=new Map(args.filter(x=>x.startsWith('--')&&x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(2,i),x.slice(i+1)];}));
  const input=path.resolve(flags.get('input')||DEFAULT_INPUT),output=path.resolve(flags.get('output')||DEFAULT_OUTPUT),refresh=args.includes('--refresh');
  const num=(key,value)=>Math.max(1,Number(flags.get(key)||value));const options={refresh,concurrency:num('concurrency',10),timeoutMs:num('timeout-ms',12000),intervalMs:num('host-interval-ms',1800),followPages:num('follow-pages',2),maxAts:num('max-ats',3)};
  const data=JSON.parse(await fs.readFile(input,'utf8'));
  let selectedIds=null;
  if(flags.has('ids-file')){
    const raw=await fs.readFile(path.resolve(flags.get('ids-file')),'utf8');let parsed;try{parsed=JSON.parse(raw);}catch{parsed=raw.split(/\r?\n/).filter(Boolean);}
    const values=Array.isArray(parsed)?parsed:parsed.waiqi_company_ids||parsed.company_ids;if(!Array.isArray(values))throw Error('--ids-file must contain a JSON array, {waiqi_company_ids: []}, {company_ids: []}, or newline-delimited IDs');
    selectedIds=new Set(values.map(String));
  }
  const allCompanies=data.companies.filter(x=>(selectedIds?selectedIds.has(String(x.waiqi_company_id)):Number(x.returned_position_count)===0)&&x.website!=null&&String(x.website).trim());
  const offset=Math.max(0,Number(flags.get('offset')||0)),limit=flags.has('limit')?Math.max(0,Number(flags.get('limit'))):allCompanies.length;
  const companies=allCompanies.slice(offset,offset+limit);
  await fs.mkdir(output,{recursive:true});const rows=new Array(companies.length);let cursor=0,done=0;
  await Promise.all(Array.from({length:options.concurrency},async()=>{while(true){const index=cursor++;if(index>=companies.length)return;rows[index]=await processCompany(companies[index],output,options);done++;if(done%25===0)console.log(JSON.stringify({done,total:companies.length,verified:rows.filter(Boolean).filter(x=>x.state==='verified_api_capability').length}));}}));
  const counts={};for(const row of rows)counts[row.state]=(counts[row.state]||0)+1;
  const discoveries=rows.flatMap(row=>row.discoveries.filter(x=>x.api_verified).map(x=>({waiqi_company_id:row.waiqi_company_id,display_name:row.display_name,matched_company_ids:row.matched_company_ids,website:row.website_normalized,state:row.state,...x})));
  const sourceKeys=new Set(discoveries.map(x=>JSON.stringify([x.provider,x.api_config])));
  const summary={generated_at:new Date().toISOString(),input,output,scope:{selection:selectedIds?'explicit_ids_from_position_list_recheck':'legacy_returned_position_count_zero',all_selected_companies_with_nonempty_website:allCompanies.length,selected_offset:offset,selected_companies:companies.length},options,states:counts,companies_with_any_verified_api:new Set(discoveries.map(x=>x.waiqi_company_id)).size,verified_api_configurations:discoveries.length,distinct_verified_source_keys:sourceKeys.size,identity_confirmed_verified_configurations:discoveries.filter(x=>x.state==='verified_api_capability').length,matched_existing_company_hints:rows.filter(x=>x.matched_company_ids.length).length,policy:'Discovery only. No source registry or company metadata is modified. Admission requires entity review and source-key deduplication.'};
  await json(path.join(output,'manifest.json'),rows);await json(path.join(output,'verified-api-candidates.json'),discoveries);await json(path.join(output,'summary.json'),summary);console.log(JSON.stringify(summary,null,2));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
