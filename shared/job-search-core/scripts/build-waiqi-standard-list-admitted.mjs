import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {INDUSTRIES} from './lib/industry-routing.mjs';
import {planWaiqiIntegration,sourceKey} from './lib/waiqi-integration.mjs';
import {companyNameMatches,interfaceMatchesUrl} from './lib/waiqi-interface-identity.mjs';

const ROOT=path.resolve('shared/job-search-core/state/maintenance/waiqi-interface-deep-review/standard-ats');
const REGISTRY=path.resolve('shared/job-search-core/assets/sources.json');
const CANDIDATES=path.resolve('datasets/recruitment-links/catalog/waiqi-source-candidates.json');
const CATALOG=path.resolve('datasets/recruitment-links/catalog/waiqi-interface-catalog.json');
const WAIQI_SNAPSHOT=path.resolve('shared/job-search-core/state/maintenance/waiqi-2026-09-20');
const DEEP_REVIEW=path.resolve('shared/job-search-core/state/maintenance/waiqi-interface-deep-review/no-interface-websites');
const INTERFACE_OVERRIDES=path.resolve('shared/job-search-core/assets/waiqi-interface-overrides.json');
const hash=value=>createHash('sha256').update(value).digest('hex');
const read=file=>fs.readFile(file,'utf8').then(JSON.parse);
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2)+'\n');};
const normalized=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/(?:有限责任公司|股份有限公司|有限公司|公司|集团|中国|china|limited|ltd|inc|corporation|corp|group)/gi,'').replace(/[^\p{L}\p{N}]+/gu,'');
export const industryMap={
  '金融业':['finance'],'IT/互联网/游戏':['internet'],'能源/化工/环保':['energy_environment','materials_chemicals'],'机械/制造业':['industrial'],'通信/电子/半导体':['supply_chain','telecom'],'交通/物流/仓储':['logistics_trade'],'耐用消费品':['consumer'],'商务服务业':['professional_services'],'生活服务业':['consumer'],'法律':['professional_services'],'教育/培训/科研':['education','professional_services'],'快速消费品':['consumer'],'人力资源服务':['professional_services'],'咨询':['professional_services'],'贸易/批发/零售':['consumer','logistics_trade'],'医疗/医药/生物':['healthcare'],'汽车制造/维修/零配件':['automotive_oem','supply_chain'],'文化/传媒/广告/体育':['media_tourism'],'房地产业/建筑业':['construction'],'财务/审计/税务':['professional_services'],'数字工业':['industrial'],'智能硬件':['smart_hardware'],'检测/认证':['professional_services'],'新能源':['energy_environment'],'专利/商标/知识产权':['professional_services'],'人工智能':['internet'],'政府/机构/组织':['professional_services'],'农林牧渔':['agriculture'],'能源/化工/环保 ':['energy_environment','materials_chemicals'],'自动驾驶出行服务':['automotive_oem','internet']
};
export async function evidenceFile(resultDir,result){
  if(result.identity_page?.response_file)return result.identity_page.response_file;
  const dir=path.join(resultDir,'identity');let files=[];try{files=await fs.readdir(dir);}catch{return null;}
  for(const name of files){const file=path.join(dir,name);try{const bytes=await fs.readFile(file);if(hash(bytes)===result.identity_page?.response_sha256)return file;}catch{}}
  return null;
}
export async function waiqiOutboundIdentity(row,companyRows){
  const matches=[];
  for(const company of companyRows){
    const relative=company.evidence_files?.positions;
    if(!relative)continue;
    const file=path.join(WAIQI_SNAPSHOT,relative);let snapshot;
    try{snapshot=await read(file);}catch{continue;}
    const observed=(snapshot.data||[]).filter(position=>interfaceMatchesUrl(row,position.outsideUrl)&&companyNameMatches(company,position.companyName));
    if(observed.length)matches.push({waiqi_company_id:company.waiqi_company_id,name:observed[0].companyName,evidence_file:file,outside_urls:observed.map(x=>x.outsideUrl)});
  }
  return matches;
}
export async function officialCrawlIdentity(row,companyRows){
  const matches=[];
  for(const company of companyRows){
    let result;try{result=await read(path.join(DEEP_REVIEW,String(company.waiqi_company_id),'result.json'));}catch{continue;}
    const observations=(result.observations||[]).filter(x=>x.http_status===200),identity=observations.find(x=>x.response_file&&companyNameMatches(company,x.title));
    const bound=observations.some(x=>interfaceMatchesUrl(row,x.final_url||x.url));
    if(identity&&bound)matches.push({waiqi_company_id:company.waiqi_company_id,name:company.display_name,evidence_file:identity.response_file,career_url:row.entry_url});
  }
  return matches;
}
const requestEvidence=result=>(result.capability.requests||[]).filter(r=>/job_list|country_facet|location_filtered/i.test(r.purpose||'')&&!/detail/i.test(r.purpose||'')).map(r=>({url:r.url,method:r.method,http_status:r.http_status,response_file:r.response_file,response_sha256:r.response_sha256,anonymous_session_from_scratch:r.anonymous_session_from_scratch}));
export async function main(){
  const registry=await read(REGISTRY),catalog=await read(CATALOG),candidateData=await read(CANDIDATES),companies=new Map(candidateData.companies.map(x=>[Number(x.waiqi_company_id),x])),interfaces=new Map(catalog.interfaces.map(x=>[x.interface_id,x])),items=[],pending=[];
  for(const [interfaceId,row] of interfaces){
    if(row.status==='registered_source')continue;const dir=path.join(ROOT,interfaceId);let result;try{result=await read(path.join(dir,'result.json'));}catch{continue;}
    if(!result.capability?.list_complete){pending.push({interface_id:interfaceId,provider:row.provider,waiqi_company_ids:row.waiqi_company_ids,reason:'list_not_complete',detail:result.capability?.reason});continue;}
    if(!(result.capability.jobs_observed>0)&&row.provider!=='avature_public'){pending.push({interface_id:interfaceId,provider:row.provider,waiqi_company_ids:row.waiqi_company_ids,reason:'verified_empty_list_requires_zero_job_packaging'});continue;}
    const companyRows=row.waiqi_company_ids.map(id=>companies.get(Number(id))).filter(Boolean),pageMatches=result.identity_page?.name_matches||[],outboundMatches=await waiqiOutboundIdentity(row,companyRows),crawlMatches=await officialCrawlIdentity(row,companyRows),bindingMatches=[];
    if(row.review_state==='reviewed_company_list_binding'&&row.binding_evidence){
      const company=companies.get(Number(row.binding_evidence.waiqi_company_id));
      if(company&&companyNameMatches(company,row.binding_evidence.display_name))bindingMatches.push({waiqi_company_id:company.waiqi_company_id,name:row.binding_evidence.display_name,evidence_file:INTERFACE_OVERRIDES});
    }
    const identityMatches=pageMatches.length?pageMatches:bindingMatches.length?bindingMatches:outboundMatches.length?outboundMatches:crawlMatches;
    const matchedIds=[...new Set(identityMatches.map(x=>Number(x.waiqi_company_id)))],matched=matchedIds.map(id=>companies.get(id)).filter(Boolean);
    if(!matched.length){pending.push({interface_id:interfaceId,provider:row.provider,waiqi_company_ids:row.waiqi_company_ids,reason:'official_entry_identity_not_confirmed'});continue;}
    const brandKeys=new Set(identityMatches.map(x=>normalized(x.name)).filter(Boolean));
    if(brandKeys.size>1&&!matched.every(x=>[x.display_name,...x.aliases||[]].some(n=>[...brandKeys].some(k=>normalized(n)===k)))){pending.push({interface_id:interfaceId,provider:row.provider,waiqi_company_ids:row.waiqi_company_ids,reason:'multiple_identity_names_require_review'});continue;}
    const exactExisting=[...new Set(matched.flatMap(x=>(x.match_evidence||[]).filter(e=>e.basis?.includes('exact_normalized_name')).map(e=>e.company_id)).filter(id=>registry.companies.some(c=>c.company_id===id)))];
    if(exactExisting.length>1){pending.push({interface_id:interfaceId,provider:row.provider,waiqi_company_ids:row.waiqi_company_ids,reason:'multiple_existing_exact_identity_matches',company_ids:exactExisting});continue;}
    const identityFile=pageMatches.length?await evidenceFile(dir,result):bindingMatches[0]?.evidence_file||outboundMatches[0]?.evidence_file||crawlMatches[0]?.evidence_file;if(!identityFile){pending.push({interface_id:interfaceId,provider:row.provider,waiqi_company_ids:row.waiqi_company_ids,reason:'identity_response_file_missing'});continue;}
    const examples=(row.request_templates||[]).filter(q=>!/detail/i.test(q.purpose||'')).map(q=>({...q,purpose:'job_list'}));if(!examples.length){pending.push({interface_id:interfaceId,provider:row.provider,waiqi_company_ids:row.waiqi_company_ids,reason:'list_request_template_missing'});continue;}
    const tags=[...new Set(matched.flatMap(x=>industryMap[x.industry_hint]||[]))];if(!tags.length){pending.push({interface_id:interfaceId,provider:row.provider,waiqi_company_ids:row.waiqi_company_ids,reason:'industry_routing_missing'});continue;}
    const existing=exactExisting[0]&&registry.companies.find(x=>x.company_id===exactExisting[0]),names=[...new Set(identityMatches.map(x=>x.name.trim()).filter(Boolean))],display=existing?.display_name||matched[0].display_name||names.sort((a,b)=>a.length-b.length)[0],key=sourceKey({provider:row.provider,api_config:row.api_config,primary_entry_url:row.entry_url,validated_api_request_examples:examples});
    const identityBasis=pageMatches.length
      ? `Official recruitment entry ${result.identity_page.final_url||result.identity_page.requested_url} is titled “${result.identity_page.title||display}” and contains the reviewed Waiqi name ${names.join(' / ')}.`
      : bindingMatches.length?`The reviewed Waiqi interface binding maps ${names.join(' / ')} to MoSeeker company ${row.api_config.company_id}; the anonymous company list independently exposes the same employer name and complete list inventory.`
      : outboundMatches.length?`The saved Waiqi company position-list response identifies ${names.join(' / ')} and returns an official outsideUrl on this exact recruitment interface. The interface binding uses companyName plus provider tenant/site, without requesting the individual job page.`
      : `The reviewed Waiqi official company website identifies ${names.join(' / ')} and its saved career-link crawl reaches this exact recruitment interface. No individual job page was requested.`;
    const companyId=existing?.company_id||'waiqi-list-'+hash(key).slice(0,12),basis=`${identityBasis} The anonymous public list completed pagination with ${result.capability.jobs_observed} unique IDs. No individual job detail was requested.`;
    const item={company_id:companyId,display_name:display,aliases:names.filter(x=>x!==display),provider:row.provider,category:(existing?.industry_tags||tags)[0],industry_tags:existing?.industry_tags?.length?[...existing.industry_tags]:tags,primary_entry_url:row.entry_url,api_config:row.api_config,validated_api_request_examples:examples,source_id:'waiqi-list-'+interfaceId,admitted:true,verification_status:'verified_public_list_only',verified_at:result.checked_at,identity_verification:{identity_verified:true,official_name:display,evidence_file:identityFile,basis},source_verification:{checked_at:result.checked_at,identity_basis:basis,proof_directory:dir,observed_jobs:result.capability.jobs_observed,complete_jd_samples:0,scope:'Public company list only; geography, recruitment direction and complete JD are not established.',public_list_capability:{anonymous:true,list_complete:true,jobs_observed:result.capability.jobs_observed,request_evidence:requestEvidence(result)}},discovery_provenance:{dataset:'waiqi-company-interface-deep-review',waiqi_company_id:matched[0].waiqi_company_id,related_waiqi_company_ids:matchedIds,company_url:matched[0].source_url,interface_id:interfaceId,identity_scope:'reviewed_official_recruitment_entry'},merge_group_key:'waiqi-list-'+interfaceId,suggested_group_display_name:display,...existing?{suggested_existing_company_id:existing.company_id}:{}};
    items.push(item);
  }
  const plan=planWaiqiIntegration(registry,items.map(item=>({item,file:path.join(ROOT,'admitted.json')})),INDUSTRIES.map(x=>x.id));
  const summary={generated_at:new Date().toISOString(),reviewed_results:items.length+pending.length,integration_ready:items.length,pending:pending.length,preview:{added_configurations:plan.added.length,new_companies:plan.added.filter(x=>x.new_company).length,already_registered:plan.skipped.length,rejected:plan.rejected.length,rejections:plan.rejected},policy:'Positive, fully reconciled public lists with official-entry identity only. Empty lists use the separate zero-job policy. No JD details were requested.'};
  await write(path.join(ROOT,'admitted.json'),items);await write(path.join(ROOT,'pending.json'),pending);await write(path.join(ROOT,'preview.json'),summary);console.log(JSON.stringify(summary,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
