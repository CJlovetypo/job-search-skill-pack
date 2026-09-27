import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createClient} from './lib/http.mjs';
import {collectInternational} from './lib/providers-international.mjs';
import {collectCommon} from './lib/providers-common.mjs';
import {collectJobs2web} from './lib/provider-jobs2web.mjs';
import {collectTupu360} from './lib/provider-tupu360.mjs';
import {collectMoseeker} from './lib/provider-moseeker.mjs';
import {collectPhenom} from './lib/provider-phenom.mjs';
import {collectEightfold} from './lib/provider-eightfold.mjs';
import {collectAvature} from './lib/provider-avature.mjs';
import {isIndividualJobRoute} from './lib/career-link-scope.mjs';

const DEFAULT_INPUT=path.resolve('datasets/recruitment-links/catalog/waiqi-interface-catalog.json');
const DEFAULT_COMPANIES=path.resolve('datasets/recruitment-links/catalog/waiqi-source-candidates.json');
const DEFAULT_OUTPUT=path.resolve('shared/job-search-core/state/maintenance/waiqi-interface-deep-review/standard-ats');
const providers=new Set(['workday','oracle_recruiting','smartrecruiters','greenhouse','ashby','tupu360','moseeker_public','phenom_public','eightfold_public','avature_public','beisen','moka','feishu','hotjob','jobs2web_public']);
const read=file=>fs.readFile(file,'utf8').then(JSON.parse);
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.tmp-'+process.pid;await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n');await fs.rename(temp,file);};
const text=html=>String(html||'').replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[（(].*?[)）]/g,'').replace(/(?:有限责任公司|股份有限公司|有限公司|公司|集团|中国|china|limited|ltd|inc|corporation|corp|group)/gi,'').replace(/[^\p{L}\p{N}]+/gu,'');
function identity(companyRows,html,title=''){
  const page=norm(title+' '+text(html).slice(0,300000)),matches=[];
  for(const company of companyRows)for(const name of [company.display_name,...company.aliases||[]]){const n=norm(name);if(n.length>=3&&page.includes(n))matches.push({waiqi_company_id:company.waiqi_company_id,name,basis:'normalized_name_in_official_entry'});}
  return [...new Map(matches.map(x=>[x.waiqi_company_id+'|'+x.name,x])).values()];
}
function validListTemplates(row){return row.request_templates.filter(q=>!isIndividualJobRoute(q.url)&&!/detail/i.test(q.purpose||''));}
function canonicalEntry(row){
  const u=new URL(row.entry_url);
  if(row.provider==='beisen')return u.origin+'/';
  if(row.provider==='moka'){const m=u.pathname.match(/\/(campus-recruitment|social-recruitment|apply)\/[^/]+\/\d+/i);if(m)return u.origin+m[0];}
  if(row.provider==='feishu')return u.origin+'/'+(u.pathname.split('/').filter(Boolean)[0]||'index');
  if(row.provider==='hotjob'){const tenant=u.pathname.split('/').find(x=>/^SU[a-zA-Z0-9]+$/.test(x));if(tenant)return u.origin+'/'+tenant+'/index';}
  if(row.provider==='tupu360')return u.origin+'/position/list?type=SOCIALRECRUITMENT&lang=zh_CN';
  if(row.provider==='moseeker_public')return 'https://www.moseeker.com/positions/index/cid/'+row.api_config.company_id;
  if(row.provider==='phenom_public')return row.api_config.origin+row.api_config.search_path;
  if(row.provider==='eightfold_public')return row.entry_url;
  return row.entry_url;
}
async function verifyDirect(row,dir){
  const client=createClient({evidenceDir:path.join(dir,'api'),timeoutMs:20000}),template=validListTemplates(row)[0];
  if(!template)throw Error('No company list request template');
  const ids=new Set(),pages=[];let total=null,complete=false,reason='max_pages_reached',totalChanged=false,duplicates=false;
  if(row.provider==='workday'){
    const endpoint=`${row.api_config.origin}/wday/cxs/${row.api_config.tenant}/${row.api_config.site}/jobs`;
    for(let page=0;page<100;page++){
      const size=20,offset=page*size,r=await client.request({url:endpoint,method:'POST',headers:{'Content-Type':'application/json'},body:{appliedFacets:{},limit:size,offset,searchText:''}},{purpose:'company_job_list'}),jobs=r.data?.jobPostings,nextTotal=Number(r.data?.total);
      if(r.record.http_status!==200||!Array.isArray(jobs)||!Number.isSafeInteger(nextTotal)||nextTotal<0)throw Error('Workday list schema or HTTP error');
      if(total!==null&&total!==nextTotal)totalChanged=true;total=nextTotal;const before=ids.size;
      for(const job of jobs){const id=String(job.externalPath||job.externalUrl||job.bulletFields?.[0]||'');if(!id)throw Error('Workday row missing stable identity');if(ids.has(id)){duplicates=true;continue;}ids.add(id);}
      pages.push({returned:jobs.length,total,response_sha256:r.record.response_sha256});
      if(ids.size===total){complete=!totalChanged&&!duplicates;reason=complete?'unique_paths_reconcile_server_total':'inventory_changed_during_pagination';break;}
      if(ids.size===before||!jobs.length){reason='repeated_or_empty_page_before_total';break;}
    }
  }else if(row.provider==='greenhouse'){
    const r=await client.request({url:template.url,method:'GET'},{purpose:'company_job_list'}),jobs=r.data?.jobs;
    if(r.record.http_status!==200||!Array.isArray(jobs))throw Error('Greenhouse list schema or HTTP error');
    for(const j of jobs){if(!j.id)throw Error('Greenhouse row missing ID');ids.add(String(j.id));}
    total=jobs.length;complete=true;reason='single_complete_board_response';pages.push({returned:jobs.length,response_sha256:r.record.response_sha256});
  }else if(row.provider==='ashby'){
    const r=await client.request({url:'https://api.ashbyhq.com/posting-api/job-board/'+encodeURIComponent(row.api_config.board_token),method:'GET'},{purpose:'company_job_list'}),jobs=r.data?.jobs;
    if(r.record.http_status!==200||!Array.isArray(jobs))throw Error('Ashby list schema or HTTP error');
    for(const j of jobs){const id=String(j.id||j.jobUrl||'');if(!id)throw Error('Ashby row missing ID');ids.add(id);}
    total=jobs.length;complete=ids.size===total;reason=complete?'single_complete_board_response':'duplicate_or_missing_job_ids';pages.push({returned:jobs.length,response_sha256:r.record.response_sha256});
  }else if(row.provider==='oracle_recruiting'){
    const base=new URL(template.url),finder=base.searchParams.get('finder')||'',site=(finder.match(/siteNumber=([^,;]+)/)||[])[1]||row.api_config.site;
    if(!site)throw Error('Oracle site missing');
    for(let page=0;page<100;page++){
      const size=200,offset=page*size,u=new URL(row.api_config.origin+'/hcmRestApi/resources/latest/recruitingCEJobRequisitions');
      u.searchParams.set('onlyData','true');u.searchParams.set('expand','requisitionList.secondaryLocations');u.searchParams.set('finder','findReqs;siteNumber='+site+',facetsList=NONE,limit='+size+',offset='+offset);
      const r=await client.request({url:u.href,method:'GET'},{purpose:'company_job_list'}),item=r.data?.items?.[0],jobs=item?.requisitionList,nextTotal=Number(item?.TotalJobsCount);
      if(r.record.http_status!==200||!Array.isArray(jobs)||!Number.isFinite(nextTotal))throw Error('Oracle list schema or HTTP error');
      if(total!==null&&total!==nextTotal)throw Error('Oracle total changed');total=nextTotal;const before=ids.size;
      for(const j of jobs){if(!j.Id)throw Error('Oracle row missing ID');if(ids.has(String(j.Id)))throw Error('Oracle duplicate ID');ids.add(String(j.Id));}
      pages.push({returned:jobs.length,total,response_sha256:r.record.response_sha256});
      if(ids.size===total){complete=true;reason='unique_ids_reconcile_server_total';break;}
      if(ids.size===before||!jobs.length)throw Error('Oracle repeated or empty page before total');
    }
  }
  return {checked_at:new Date().toISOString(),jobs_observed:ids.size,server_total:total,list_complete:complete,status:complete?'verified_list':'partial',reason,pages,requests:client.records};
}
async function verifyCollector(row,dir,company){
  const templates=validListTemplates(row);if(!templates.length)throw Error('No company list request template');
  const source={company_id:'waiqi-interface-'+row.interface_id,display_name:company?.display_name||row.interface_id,provider:row.provider,primary_entry_url:canonicalEntry(row),api_config:row.api_config,validated_api_request_examples:templates};
  const options={mode:'list',maxDetails:0,maxPages:100,pageSize:row.provider==='workday'?20:50,timeoutMs:20000,evidenceDir:path.join(dir,'api')};
  const result=row.provider==='smartrecruiters'?await collectInternational(source,options):row.provider==='jobs2web_public'?await collectJobs2web(source,options):row.provider==='tupu360'?await collectTupu360(source,options):row.provider==='moseeker_public'?await collectMoseeker(source,options):row.provider==='phenom_public'?await collectPhenom(source,options):row.provider==='eightfold_public'?await collectEightfold(source,options):row.provider==='avature_public'?await collectAvature(source,options):await collectCommon(source,options);
  if(!result)throw Error('Provider collector unavailable');
  if(result.requests.some(r=>/detail/i.test(r.purpose||'')||isIndividualJobRoute(r.url)))throw Error('List-only verifier attempted an individual job request');
  const listComplete=result.coverage.list_complete===true||(result.coverage.contexts?.length>0&&result.coverage.contexts.every(x=>x.list_complete===true));
  return {checked_at:result.checked_at,jobs_observed:result.jobs.length,server_total:result.coverage.server_total,list_complete:listComplete,status:listComplete?'verified_list':result.coverage.pages?'partial':'failed',reason:result.coverage.reason,pages:result.coverage.pages,requests:result.requests};
}
async function processRow(row,companyMap,output,refresh,retryIncomplete){
  const dir=path.join(output,row.interface_id),file=path.join(dir,'result.json');
  try{const cached=JSON.parse(await fs.readFile(file,'utf8'));if(!refresh&&!(retryIncomplete&&cached.capability?.list_complete!==true))return cached;}catch{}
  const companyRows=row.waiqi_company_ids.map(id=>companyMap.get(Number(id))).filter(Boolean),company=companyRows[0];let capability,error=null;
    try{capability=['workday','oracle_recruiting','greenhouse','ashby'].includes(row.provider)?await verifyDirect(row,dir):await verifyCollector(row,dir,company);}catch(e){error=e.message;capability={checked_at:new Date().toISOString(),jobs_observed:0,server_total:null,list_complete:false,status:'failed',reason:e.message,pages:0,requests:[]};}
  const identityClient=createClient({evidenceDir:path.join(dir,'identity'),timeoutMs:15000,requestBudget:{remaining:1}});let identityPage=null;
  try{const identityURL=canonicalEntry(row),r=await identityClient.request({url:identityURL,headers:{Accept:'text/html,application/xhtml+xml'}},{purpose:'company_recruitment_entry'});identityPage={requested_url:identityURL,final_url:r.url,http_status:r.record.http_status,title:r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g,' ').trim()||null,response_file:r.record.response_file,response_sha256:r.record.response_sha256,name_matches:identity(companyRows,r.text,r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1])};}catch(e){identityPage={requested_url:canonicalEntry(row),error:e.message,name_matches:[]};}
  const result={interface_id:row.interface_id,provider:row.provider,entry_url:row.entry_url,api_config:row.api_config,waiqi_company_ids:row.waiqi_company_ids,checked_at:new Date().toISOString(),capability,identity_page:identityPage,identity_status:identityPage.name_matches.length?'name_observed_on_entry':'requires_review',error,policy:'Company entry and complete public list pagination only; no individual job detail requested.'};
  await write(file,result);return result;
}
export async function main(args=process.argv.slice(2)){
  const arg=k=>args.find(x=>x.startsWith('--'+k+'='))?.slice(k.length+3),refresh=args.includes('--refresh'),retryIncomplete=args.includes('--retry-incomplete'),input=path.resolve(arg('input')||DEFAULT_INPUT),output=path.resolve(arg('output')||DEFAULT_OUTPUT),concurrency=Math.max(1,Number(arg('concurrency')||4));
  const catalog=await read(input),candidates=await read(DEFAULT_COMPANIES),companyMap=new Map(candidates.companies.map(x=>[Number(x.waiqi_company_id),x]));let rows=catalog.interfaces.filter(x=>x.status!=='registered_source'&&providers.has(x.provider));
  const only=arg('providers');if(only){const selected=new Set(only.split(','));rows=rows.filter(x=>selected.has(x.provider));}
  await fs.mkdir(output,{recursive:true});const results=new Array(rows.length);let cursor=0,done=0;
  await Promise.all(Array.from({length:concurrency},async()=>{while(true){const i=cursor++;if(i>=rows.length)return;results[i]=await processRow(rows[i],companyMap,output,refresh,retryIncomplete);done++;if(done%20===0)console.log(JSON.stringify({done,total:rows.length,verified:results.filter(Boolean).filter(x=>x.capability.list_complete).length}));}}));
  const summary={generated_at:new Date().toISOString(),interfaces:results.length,companies:new Set(results.flatMap(x=>x.waiqi_company_ids)).size,states:results.reduce((s,x)=>(s[x.capability.status]=(s[x.capability.status]||0)+1,s),{}),identity_name_observed:results.filter(x=>x.identity_status==='name_observed_on_entry').length,policy:'No individual job detail requests. List completeness and employer identity are reported independently.'};
  await write(path.join(output,'manifest.json'),results);await write(path.join(output,'summary.json'),summary);console.log(JSON.stringify(summary,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
