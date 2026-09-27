import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createClient} from './lib/http.mjs';
import {normalizeWorkday,normalizeSmartRecruiters,isMainlandChinaCountry,assertWorkdayDetailIdentity} from './lib/providers-international.mjs';
import {normalizeRecovered} from './lib/providers-recovered.mjs';
import {normalizeOracleNowcoder} from './lib/providers-oracle-nowcoder.mjs';
import {collectCommon} from './lib/providers-common.mjs';
import {reviewJobBody} from './lib/body-review.mjs';
import {publicSiteConfig} from './lib/source-directions.mjs';
import {sourceFromEntry} from './source-discovery.mjs';
import {atsConfiguration} from './discover-waiqi-zero-websites.mjs';

const ROOT=path.resolve('shared/job-search-core/state/maintenance/waiqi-2026-09-20');
const DEFAULT_INPUT=path.join(ROOT,'zero-position-official-discovery/verified-api-candidates.json');
const DEFAULT_OUTPUT=path.join(ROOT,'zero-position-official-clean');
const DEFAULT_COMPANIES=path.resolve('datasets/recruitment-links/catalog/waiqi-source-candidates.json');
const DEFAULT_REGISTRY=path.resolve('shared/job-search-core/assets/sources.json');
const chinaPlace=/(?:\bChina\b|中国大陆|中国内地|上海|北京|深圳|广州|苏州|杭州|成都|南京|武汉|厦门|天津|宁波|东莞|青岛|大连|无锡|常州|合肥|西安|重庆|珠海|佛山|郑州|长沙|沈阳)/i;
const notMainland=/(?:Hong Kong|香港|Taiwan|台湾|Macao|Macau|澳门)/i;
const legalSuffix=/(?:有限责任公司|股份有限公司|有限公司|集团|控股|中国|\b(?:co(?:mpany)?|corp(?:oration)?|inc(?:orporated)?|ltd|limited|llc|plc|holdings?|group|china)\b)/gi;

const json=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.tmp-'+process.pid;await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n');await fs.rename(temp,file);};
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const hash=value=>createHash('sha256').update(String(value)).digest('hex').slice(0,16);
const clean=s=>String(s||'').replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&quot;/gi,'"').replace(/&amp;/gi,'&').trim().split(/["'<>\s]/,1)[0].replace(/[},;]+$/,'');
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(legalSuffix,'').replace(/[^\p{L}\p{N}]+/gu,'');
const unique=a=>[...new Set(a.filter(Boolean))];
const namesFor=c=>unique([c.display_name,...(c.aliases||[])]).map(x=>({raw:x,norm:norm(x)})).filter(x=>x.norm.length>=3);
function nameMatch(names,observed){
  const official=unique(observed.flatMap(x=>typeof x==='string'?[x]:x&&typeof x==='object'?[x.name,x.descriptor,x.displayName].filter(Boolean):[]));
  const left=namesFor(names),right=official.map(x=>({raw:x,norm:norm(x)})).filter(x=>x.norm.length>=2),matches=[];
  for(const a of left)for(const b of right){const shorter=a.norm.length<=b.norm.length?a:b,longer=a.norm.length>b.norm.length?a:b,cjk=/[\p{Script=Han}]/u.test(shorter.norm);if(shorter.norm===longer.norm||(shorter.norm.length>=(cjk?2:4)&&longer.norm.includes(shorter.norm)&&shorter.norm.length/longer.norm.length>=(cjk?0.3:0.45)))matches.push({candidate:a.raw,official:b.raw});}
  return matches;
}
function tokenMatch(company,token){
  const t=norm(token);if(t.length<3)return [];
  return namesFor(company).filter(x=>x.norm===t||(Math.min(x.norm.length,t.length)>=4&&(x.norm.includes(t)||t.includes(x.norm)))).map(x=>x.raw);
}
export function cleanConfiguration(candidate){
  const entry=clean(candidate.entry_url),parsed=atsConfiguration(entry);if(!parsed||parsed.provider!==candidate.provider)return {error:'strict_parser_rejected_entry_url',entry};
  if(parsed.provider==='workday'&&parsed.entry_kind==='job_detail'&&/^(?:openapplication|open_application|search|apply)$/i.test(parsed.api_config.site))return {error:'specialty_or_generic_workday_job_path_is_not_a_canonical_site',entry,parsed};
  parsed.observed_entry_url=entry;
  if(parsed.provider==='workday')parsed.entry_url=parsed.api_config.origin+'/en-US/'+encodeURIComponent(parsed.api_config.site);
  if(parsed.provider==='greenhouse')parsed.entry_url='https://job-boards.greenhouse.io/'+encodeURIComponent(parsed.api_config.board_token);
  if(parsed.provider==='smartrecruiters')parsed.entry_url='https://careers.smartrecruiters.com/'+encodeURIComponent(parsed.api_config.company_identifier);
  return {entry,parsed};
}
function contextKey(config){
  const a=config.api_config||{},u=new URL(config.entry_url);
  if(config.provider==='workday')return `workday|${new URL(a.origin).origin.toLowerCase()}|${a.tenant.toLowerCase()}|${a.site.toLowerCase()}`;
  if(config.provider==='smartrecruiters')return `smartrecruiters|${a.company_identifier.toLowerCase()}`;
  if(config.provider==='greenhouse')return `greenhouse|${a.board_token.toLowerCase()}`;
  if(config.provider==='oracle_recruiting')return `oracle_recruiting|${new URL(a.origin).origin.toLowerCase()}|${a.site.toLowerCase()}`;
  if(config.provider==='moka'){const q=config.source.validated_api_request_examples[0],b=q.body;return `moka|${new URL(q.url).origin.toLowerCase()}|${String(b.orgId).toLowerCase()}|${b.siteId}`;}
  if(config.provider==='hotjob')return `hotjob|${config.entry_url.match(/SU[\da-f]{24}/i)?.[0].toLowerCase()}`;
  return `${config.provider}|${u.origin.toLowerCase()}`;
}
function registryContext(source){
  const a=source.api_config||{},entry=source.primary_entry_url||source.entry_url;let u;try{u=new URL(entry);}catch{return null;}
  if(source.provider==='workday'&&a.origin&&a.tenant&&a.site)return `workday|${new URL(a.origin).origin.toLowerCase()}|${String(a.tenant).toLowerCase()}|${String(a.site).toLowerCase()}`;
  if(source.provider==='smartrecruiters'&&a.company_identifier)return `smartrecruiters|${String(a.company_identifier).toLowerCase()}`;
  if(source.provider==='greenhouse'&&a.board_token)return `greenhouse|${String(a.board_token).toLowerCase()}`;
  if(source.provider==='oracle_recruiting'&&a.origin&&a.site)return `oracle_recruiting|${new URL(a.origin).origin.toLowerCase()}|${String(a.site).toLowerCase()}`;
  if(source.provider==='moka'){const q=source.validated_api_request_examples?.find(q=>/\/website\/jobs\/v2/.test(q.url)),m=u.pathname.match(/\/(?:campus-recruitment|social-recruitment|apply)\/([^/]+)\/(\d+)/i);const org=q?.body?.orgId||m?.[1],site=q?.body?.siteId||m?.[2];if(org&&site)return `moka|${u.origin.toLowerCase()}|${String(org).toLowerCase()}|${site}`;}
  if(source.provider==='hotjob'){const su=entry.match(/SU[\da-f]{24}/i)?.[0];if(su)return `hotjob|${su.toLowerCase()}`;}
  if(['beisen','feishu'].includes(source.provider))return `${source.provider}|${u.origin.toLowerCase()}`;
  return null;
}
function chinaFacet(facets){let answer=null;const visit=v=>{if(!v||typeof v!=='object')return;if(v.facetParameter&&Array.isArray(v.values)){const x=v.values.find(x=>isMainlandChinaCountry(x.descriptor));if(x)answer={field:v.facetParameter,value:x.id,label:x.descriptor,count:Number(x.count)};}for(const x of Object.values(v))if(x&&typeof x==='object')Array.isArray(x)?x.forEach(visit):visit(x);};visit(facets);return answer;}
async function requestJson(client,q,purpose){const r=await client.request(q,{purpose});if(r.record.http_status!==200||!r.data)throw Error('Expected public JSON HTTP '+r.record.http_status);return r;}

async function verifyWorkday(group,dir){
  const cfg=group.config.api_config,client=createClient({evidenceDir:path.join(dir,'http'),timeoutMs:20000}),list=cfg.origin+'/wday/cxs/'+cfg.tenant+'/'+cfg.site+'/jobs';
  try{
    const boot=await requestJson(client,{url:list,method:'POST',body:{appliedFacets:{},limit:20,offset:0,searchText:''}},'global_list_and_country_facet');
    if(!Array.isArray(boot.data.jobPostings)||!Number.isFinite(Number(boot.data.total)))throw Error('Missing Workday list/total');
    const facet=chinaFacet(boot.data.facets);let chinaRows=[],chinaTotal=0,chinaRecord=null;
    if(facet&&facet.count!==0){const r=await requestJson(client,{url:list,method:'POST',body:{appliedFacets:{[facet.field]:[facet.value]},limit:20,offset:0,searchText:''}},'mainland_china_job_list');if(!Array.isArray(r.data.jobPostings)||!Number.isFinite(Number(r.data.total)))throw Error('Missing filtered list/total');chinaRows=r.data.jobPostings;chinaTotal=Number(r.data.total);chinaRecord=r.record;}
    const row=chinaRows[0]||boot.data.jobPostings[0];let job=null,employers=[];
    if(row){const detail=await requestJson(client,{url:cfg.origin+'/wday/cxs/'+cfg.tenant+'/'+cfg.site+row.externalPath},chinaRows.length?'mainland_job_detail_sample':'global_identity_detail_sample');assertWorkdayDetailIdentity(row,detail.data);job=reviewJobBody(normalizeWorkday(detail.data,{company_id:'candidate',display_name:group.members[0].display_name,provider:'workday',api_config:cfg},detail.record));const hiring=detail.data.hiringOrganization;employers=unique([typeof hiring==='string'?hiring:hiring?.name,hiring?.descriptor,detail.data.jobPostingInfo?.hiringOrganization?.descriptor,detail.data.jobPostingInfo?.company]);}
    return {ok:true,provider:'workday',mainland_total:chinaTotal,global_total:Number(boot.data.total),mainland_filter:facet,employer_names:employers,complete_api_jd:!!job?.body_complete,complete_mainland_jd:!!(chinaRows.length&&job?.body_complete),sample_job:job,requests:client.records,list_record:chinaRecord||boot.record};
  }catch(error){return {ok:false,provider:'workday',reason:error.message,requests:client.records};}
}
async function verifySmartRecruiters(group,dir){
  const id=group.config.api_config.company_identifier,client=createClient({evidenceDir:path.join(dir,'http'),timeoutMs:20000}),url='https://api.smartrecruiters.com/v1/companies/'+encodeURIComponent(id)+'/postings?country=cn&limit=100&offset=0';
  try{const list=await requestJson(client,{url},'mainland_china_job_list');if(!Array.isArray(list.data.content)||!Number.isFinite(Number(list.data.totalFound)))throw Error('Missing SmartRecruiters content/totalFound');const row=list.data.content[0];let job=null,employers=[];if(row){const detail=await requestJson(client,{url:row.ref},'mainland_job_detail_sample');job=reviewJobBody(normalizeSmartRecruiters(detail.data,{company_id:'candidate',display_name:group.members[0].display_name,provider:'smartrecruiters'},detail.record,true));employers=unique([detail.data.company?.name,detail.data.company?.identifier]);}
    return {ok:true,provider:'smartrecruiters',mainland_total:Number(list.data.totalFound),employer_names:employers,complete_api_jd:!!job?.body_complete,complete_mainland_jd:!!job?.body_complete,sample_job:job,requests:client.records,list_record:list.record};
  }catch(error){return {ok:false,provider:'smartrecruiters',reason:error.message,requests:client.records};}
}
async function verifyGreenhouse(group,dir){
  const token=group.config.api_config.board_token,client=createClient({evidenceDir:path.join(dir,'http'),timeoutMs:20000});
  try{const r=await requestJson(client,{url:'https://boards-api.greenhouse.io/v1/boards/'+encodeURIComponent(token)+'/jobs?content=true'},'global_list_with_full_jd');if(!Array.isArray(r.data.jobs))throw Error('Missing Greenhouse jobs array');const china=r.data.jobs.filter(x=>chinaPlace.test(x.location?.name||'')&&!notMainland.test(x.location?.name||'')),raw=china[0]||r.data.jobs[0],job=raw?reviewJobBody(normalizeRecovered(raw,{company_id:'candidate',display_name:group.members[0].display_name,provider:'greenhouse'},r.record,true)):null,employers=unique(r.data.jobs.slice(0,10).map(x=>x.company_name));
    return {ok:true,provider:'greenhouse',mainland_total:china.length,global_total:r.data.jobs.length,employer_names:employers,complete_api_jd:!!job?.body_complete,complete_mainland_jd:!!(china.length&&job?.body_complete),sample_job:job,requests:client.records,list_record:r.record};
  }catch(error){return {ok:false,provider:'greenhouse',reason:error.message,requests:client.records};}
}
async function verifyOracle(group,dir){
  const cfg=group.config.api_config,client=createClient({evidenceDir:path.join(dir,'http'),timeoutMs:25000}),base=cfg.origin+'/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber='+encodeURIComponent(cfg.site)+',facetsList=NONE,limit=1000,offset=0';
  try{const r=await requestJson(client,{url:base},'global_list_for_mainland_filter');const first=r.data.items?.[0],rows=first?.requisitionList;if(!Array.isArray(rows)||!Number.isFinite(Number(first?.TotalJobsCount)))throw Error('Missing Oracle requisitionList/TotalJobsCount');const china=rows.filter(x=>x.PrimaryLocationCountry==='CN'),row=china[0]||rows[0];let job=null,employers=[];if(row){const detail=await requestJson(client,{url:cfg.origin+'/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22'+row.Id+'%22,siteNumber='+cfg.site},china.length?'mainland_job_detail_sample':'global_identity_detail_sample');const d=detail.data.items?.[0];if(!d||String(d.Id)!==String(row.Id))throw Error('Oracle detail ID mismatch');const merged={...row,...d};job=reviewJobBody(normalizeOracleNowcoder(merged,{company_id:'candidate',display_name:group.members[0].display_name,provider:'oracle_recruiting',api_config:cfg},detail.record,!!china.length));employers=unique([merged.LegalEmployer,merged.BusinessUnit,merged.Organization,merged.LegalEmployerName,merged.BusinessUnitName,merged.OrganizationName,merged.ExternalOrganizationName]);}
    return {ok:true,provider:'oracle_recruiting',mainland_total:china.length,global_total:Number(first.TotalJobsCount),employer_names:employers,complete_api_jd:!!job?.body_complete,complete_mainland_jd:!!(china.length&&job?.body_complete),sample_job:job,requests:client.records,list_record:r.record};
  }catch(error){return {ok:false,provider:'oracle_recruiting',reason:error.message,requests:client.records};}
}
function htmlTitle(value){const html=String(value),titles=[...html.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)].map(m=>m[1].replace(/<[^>]+>/g,' ').trim()),meta=[...html.matchAll(/<meta[^>]+(?:property=["']og:site_name["']|name=["']application-name["'])[^>]+content=["']([^"']+)/gi)].map(m=>m[1]);return unique([...titles,...meta]);}
async function domesticOrgEvidence(source,result){
  const names=[];for(const record of result.requests||[]){if(!record.response_file)continue;let raw;try{raw=await fs.readFile(record.response_file,'utf8');}catch{continue;}if(record.purpose==='public_configuration_bootstrap'){
      if(source.provider==='moka'){try{const cfg=publicSiteConfig(raw,'moka');names.push(cfg?.org?.name,cfg?.org?.displayName,cfg?.org?.siteName);}catch{}}
      names.push(...htmlTitle(raw));
    }
    if(record.purpose==='job_list'&&record.response_is_json){let d;try{d=JSON.parse(raw);}catch{continue;}if(source.provider==='beisen')names.push(...(d.Data||[]).slice(0,5).map(x=>x.Org));if(source.provider==='hotjob')names.push(...(d.data?.pageForm?.pageData||[]).slice(0,5).map(x=>x.company));}
  }return unique(names);
}
async function verifyDomestic(group,dir){
  const entry=group.config.entry_url;let source;try{source=sourceFromEntry({company_id:'candidate',display_name:group.members[0].display_name},entry,{allTypes:true});}catch(error){return {ok:false,provider:group.provider,reason:error.message,requests:[]};}
  source.target_mode=/campus|school|xiaoyuan/i.test(entry)?'campus':'social';
  try{const result=await collectCommon(source,{mode:'full',maxPages:1,pageSize:20,maxDetails:1,detailConcurrency:1,timeoutMs:20000,evidenceDir:path.join(dir,'http'),targetMode:source.target_mode});const reviewed=result.jobs.map(reviewJobBody),complete=reviewed.find(j=>j.body_complete&&j.job_id&&j.official_url),employers=await domesticOrgEvidence(source,result);return {ok:Number(result.coverage?.pages)>0,provider:source.provider,mainland_total:result.coverage?.server_total??reviewed.length,employer_names:employers,complete_api_jd:!!complete,complete_mainland_jd:!!complete,sample_job:complete||reviewed[0]||null,requests:result.requests,coverage:result.coverage,source};}
  catch(error){return {ok:false,provider:group.provider,reason:error.message,requests:[]};}
}
async function verifyGroup(group,output,refresh,retryFailed=false){
  const dir=path.join(output,'contexts',hash(group.key)),file=path.join(dir,'verification.json');if(!refresh)try{const saved=await read(file);if(!retryFailed||saved.ok)return saved;}catch{}
  let result;if(group.provider==='workday')result=await verifyWorkday(group,dir);else if(group.provider==='smartrecruiters')result=await verifySmartRecruiters(group,dir);else if(group.provider==='greenhouse')result=await verifyGreenhouse(group,dir);else if(group.provider==='oracle_recruiting')result=await verifyOracle(group,dir);else result=await verifyDomestic(group,dir);
  const row={context_key:group.key,provider:group.provider,config:group.config,checked_at:new Date().toISOString(),...result};await json(file,row);return row;
}
function associationDecision(company,member,verification){
  if(!verification.ok)return {admitted:false,reason:'api_verification_failed: '+(verification.reason||'unknown')};
  const officialMatches=nameMatch(company,verification.employer_names||[]),commonBody=member.parsed.source?.validated_api_request_examples?.[0]?.body||{},token=member.parsed.api_config?.tenant||member.parsed.api_config?.company_identifier||member.parsed.api_config?.board_token||member.parsed.api_config?.site||commonBody.orgId||new URL(member.parsed.entry_url).hostname.split('.')[0],tokenMatches=tokenMatch(company,token);
  const pageConfirmed=!!member.identity_evidence?.confirmed,pageExact=member.identity_evidence?.exact_page_name_matches||[],portfolio=/jobs\.a16z\.com|portfolio/i.test((member.official_chain||[]).join(' ')),domestic=['moka','beisen','feishu','hotjob'].includes(member.parsed.provider);
  if(portfolio&&!officialMatches.length&&!tokenMatches.length)return {admitted:false,reason:'portfolio_job_board_target_does_not_match_supplier_company',official_name_matches:officialMatches,token_matches:tokenMatches};
  if(!officialMatches.length&&!(pageConfirmed&&tokenMatches.length)&&!(domestic&&pageExact.length))return {admitted:false,reason:'ats_employer_or_tenant_identity_not_confirmed',official_name_matches:officialMatches,token_matches:tokenMatches,page_identity_confirmed:pageConfirmed,official_employer_names:verification.employer_names||[]};
  if(member.parsed.provider==='beisen'&&Number(verification.mainland_total)===0&&!commonBody.PortalId)return {admitted:false,reason:'beisen_empty_list_with_empty_portal_id_not_admissible',official_name_matches:officialMatches,token_matches:tokenMatches};
  if(Number(verification.mainland_total)>0&&!verification.complete_mainland_jd)return {admitted:false,reason:'mainland_jobs_found_but_no_complete_jd_sample',official_name_matches:officialMatches,token_matches:tokenMatches};
  return {admitted:true,reason:Number(verification.mainland_total)===0?'verified_public_api_zero_mainland_jobs':'verified_mainland_list_and_complete_jd',official_name_matches:officialMatches,token_matches:tokenMatches};
}

export async function main(args=process.argv.slice(2)){
  const options=Object.fromEntries(args.filter(x=>x.startsWith('--')&&x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(2,i),x.slice(i+1)];})),refresh=args.includes('--refresh');
  const input=path.resolve(options.input||DEFAULT_INPUT),output=path.resolve(options.output||DEFAULT_OUTPUT),candidateData=await read(path.resolve(options.companies||DEFAULT_COMPANIES)),registry=await read(path.resolve(options.registry||DEFAULT_REGISTRY)),retryFailed=args.includes('--retry-failed');
  const companies=new Map(candidateData.companies.map(x=>[String(x.waiqi_company_id),x])),existing=new Map();for(const company of registry.companies)for(const source of company.recruitment_sources?.length?company.recruitment_sources:[company]){const key=registryContext(source);if(key){if(!existing.has(key))existing.set(key,[]);existing.get(key).push({company_id:company.company_id,display_name:company.display_name,source_id:source.source_id});}}
  const raw=await read(input),groups=new Map(),prePending=[];
  for(const candidate of raw){const company=companies.get(String(candidate.waiqi_company_id))||candidate,strict=cleanConfiguration(candidate);if(strict.error){prePending.push({...candidate,reason:strict.error,cleaned_entry_url:strict.entry});continue;}const key=contextKey(strict.parsed),member={...candidate,entry_url:strict.entry,parsed:strict.parsed};if(!groups.has(key))groups.set(key,{key,provider:strict.parsed.provider,config:strict.parsed,members:[]});groups.get(key).members.push(member);}
  const pending=[...prePending],admitted=[],duplicates=[];const todo=[];
  for(const group of groups.values()){if(existing.has(group.key)){duplicates.push({context_key:group.key,provider:group.provider,existing_sources:existing.get(group.key),waiqi_companies:group.members.map(x=>({waiqi_company_id:x.waiqi_company_id,display_name:x.display_name}))});}else todo.push(group);}
  let cursor=0,done=0;const verified=new Array(todo.length),concurrency=Math.max(1,Number(options.concurrency||3));await Promise.all(Array.from({length:concurrency},async()=>{while(true){const i=cursor++;if(i>=todo.length)return;const force=refresh||options['refresh-provider']===todo[i].provider;verified[i]=await verifyGroup(todo[i],output,force,retryFailed);done++;console.log(JSON.stringify({done,total:todo.length,provider:todo[i].provider,ok:verified[i].ok,mainland:verified[i].mainland_total,context:todo[i].key}));}}));
  for(let i=0;i<todo.length;i++){const group=todo[i],verification=verified[i],decisions=[];for(const member of group.members){const company=companies.get(String(member.waiqi_company_id))||member,decision=associationDecision(company,member,verification);decisions.push({member,company,decision});}
    const good=decisions.filter(x=>x.decision.admitted);if(group.provider==='workday'&&good.length){const sameTenant=good.filter(x=>x.member.parsed.api_config.tenant===good[0].member.parsed.api_config.tenant);if(sameTenant.length>1){sameTenant.sort((a,b)=>Number(b.member.parsed.entry_kind==='site_root')-Number(a.member.parsed.entry_kind==='site_root')||Number(b===good[0])-Number(a===good[0]));}}
    for(const x of decisions){const base={context_key:group.key,provider:group.provider,waiqi_company_id:x.member.waiqi_company_id,display_name:x.company.display_name,aliases:x.company.aliases||[],matched_company_ids:x.company.matched_company_ids||[],primary_entry_url:group.config.entry_url,api_config:group.config.api_config,official_chain:x.member.official_chain,identity_evidence:x.member.identity_evidence,verification_file:path.relative(output,path.join(output,'contexts',hash(group.key),'verification.json')).replaceAll('\\','/'),verified_at:verification.checked_at,mainland_total:verification.mainland_total??null,global_total:verification.global_total??null,complete_api_jd:!!verification.complete_api_jd,complete_mainland_jd:!!verification.complete_mainland_jd,employer_names:verification.employer_names||[],sample_job:verification.sample_job||null,...x.decision};if(x.decision.admitted)admitted.push(base);else pending.push(base);}
  }
  // One source context may be attached to multiple Waiqi rows. Keep the strongest reviewed identity and retain the others as pending associations.
  const selected=[],byContext=new Map();for(const row of admitted){if(!byContext.has(row.context_key))byContext.set(row.context_key,[]);byContext.get(row.context_key).push(row);}for(const rows of byContext.values()){rows.sort((a,b)=>Number(b.official_name_matches?.length>0)-Number(a.official_name_matches?.length>0)||Number(b.identity_evidence?.confirmed)-Number(a.identity_evidence?.confirmed)||String(a.display_name).localeCompare(String(b.display_name),'zh-CN'));selected.push(rows[0]);for(const extra of rows.slice(1))pending.push({...extra,admitted:false,reason:'duplicate_context_association_lower_identity_rank',selected_waiqi_company_id:rows[0].waiqi_company_id});}
  const summary={generated_at:new Date().toISOString(),raw_discovery_rows:raw.length,strict_contexts:groups.size,invalid_or_malformed_rows:prePending.length,existing_contexts:duplicates.length,contexts_verified:todo.length,admitted_contexts:selected.length,pending_associations:pending.length,provider_counts:Object.fromEntries([...new Set([...selected,...pending].map(x=>x.provider).filter(Boolean))].map(p=>[p,{admitted:selected.filter(x=>x.provider===p).length,pending:pending.filter(x=>x.provider===p).length}])),policy:'No registry mutation. Each admitted context requires an official website chain, ATS employer/tenant identity, a public mainland list, and one complete mainland JD when mainland jobs exist. Zero-mainland-job APIs may pass with strict entity identity.'};
  await json(path.join(output,'admitted.json'),selected);await json(path.join(output,'pending.json'),pending);await json(path.join(output,'duplicates-existing.json'),duplicates);await json(path.join(output,'clean-candidates.json'),[...groups.values()].map(g=>({context_key:g.key,provider:g.provider,config:g.config,members:g.members.map(x=>({waiqi_company_id:x.waiqi_company_id,display_name:x.display_name,official_chain:x.official_chain,identity_evidence:x.identity_evidence}))})));await json(path.join(output,'summary.json'),summary);console.log(JSON.stringify(summary,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
