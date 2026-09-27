import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {INDUSTRIES} from './lib/industry-routing.mjs';
import {planWaiqiIntegration,sourceKey} from './lib/waiqi-integration.mjs';
import {companyNameMatches,interfaceMatchesUrl} from './lib/waiqi-interface-identity.mjs';

const ROOT=path.resolve('shared/job-search-core/state/maintenance/waiqi-interface-deep-review/standard-ats');
const SNAPSHOT=path.resolve('shared/job-search-core/state/maintenance/waiqi-2026-09-20');
const REGISTRY=path.resolve('shared/job-search-core/assets/sources.json');
const CANDIDATES=path.resolve('datasets/recruitment-links/catalog/waiqi-source-candidates.json');
const CATALOG=path.resolve('datasets/recruitment-links/catalog/waiqi-interface-catalog.json');
const DEEP_REVIEW=path.resolve('shared/job-search-core/state/maintenance/waiqi-interface-deep-review/no-interface-websites');
const read=file=>fs.readFile(file,'utf8').then(JSON.parse);
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2)+'\n');};
const hash=value=>createHash('sha256').update(value).digest('hex');
const normalized=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/(?:有限责任公司|股份有限公司|有限公司|公司|集团|中国|china|limited|ltd|inc|corporation|corp|group)/gi,'').replace(/[^\p{L}\p{N}]+/gu,'');
const industryMap={'金融业':['finance'],'IT/互联网/游戏':['internet'],'能源/化工/环保':['energy_environment','materials_chemicals'],'机械/制造业':['industrial'],'通信/电子/半导体':['supply_chain','telecom'],'交通/物流/仓储':['logistics_trade'],'耐用消费品':['consumer'],'商务服务业':['professional_services'],'生活服务业':['consumer'],'法律':['professional_services'],'教育/培训/科研':['education','professional_services'],'快速消费品':['consumer'],'人力资源服务':['professional_services'],'咨询':['professional_services'],'贸易/批发/零售':['consumer','logistics_trade'],'医疗/医药/生物':['healthcare'],'汽车制造/维修/零配件':['automotive_oem','supply_chain'],'文化/传媒/广告/体育':['media_tourism'],'房地产业/建筑业':['construction'],'财务/审计/税务':['professional_services'],'数字工业':['industrial'],'智能硬件':['smart_hardware'],'检测/认证':['professional_services'],'新能源':['energy_environment'],'专利/商标/知识产权':['professional_services'],'人工智能':['internet'],'政府/机构/组织':['professional_services'],'农林牧渔':['agriculture'],'能源/化工/环保 ':['energy_environment','materials_chemicals'],'自动驾驶出行服务':['automotive_oem','internet']};
const listPath={workday:'jobPostings',oracle_recruiting:'items[].requisitionList',smartrecruiters:'content',greenhouse:'jobs',ashby:'jobs',tupu360:'result.positions',beisen:'Data',moka:'data.jobs',feishu:'data.job_post_list',hotjob:'data.pageForm.pageData'};

async function pageEvidence(dir,result){
  if(result.identity_page?.response_file)return result.identity_page.response_file;
  const evidenceDir=path.join(dir,'identity');let names=[];try{names=await fs.readdir(evidenceDir);}catch{return null;}
  for(const name of names){const file=path.join(evidenceDir,name);try{if(hash(await fs.readFile(file))===result.identity_page?.response_sha256)return file;}catch{}}
  return null;
}
async function outboundEvidence(row,companyRows){
  const matches=[];
  for(const company of companyRows){
    const relative=company.evidence_files?.positions;if(!relative)continue;
    const file=path.join(SNAPSHOT,relative);let snapshot;try{snapshot=await read(file);}catch{continue;}
    const positions=(snapshot.data||[]).filter(p=>interfaceMatchesUrl(row,p.outsideUrl)&&companyNameMatches(company,p.companyName));
    if(positions.length)matches.push({waiqi_company_id:company.waiqi_company_id,name:positions[0].companyName,evidence_file:file});
  }
  return matches;
}
async function crawlEvidence(row,companyRows){
  const matches=[];
  for(const company of companyRows){let result;try{result=await read(path.join(DEEP_REVIEW,String(company.waiqi_company_id),'result.json'));}catch{continue;}
    const observations=(result.observations||[]).filter(x=>x.http_status===200),identity=observations.find(x=>x.response_file&&companyNameMatches(company,x.title));
    if(identity&&observations.some(x=>interfaceMatchesUrl(row,x.final_url||x.url)))matches.push({waiqi_company_id:company.waiqi_company_id,name:company.display_name,evidence_file:identity.response_file});
  }
  return matches;
}
const requestEvidence=result=>(result.capability.requests||[]).filter(r=>/job_list/i.test(r.purpose||'')&&!/detail/i.test(r.purpose||'')).map(r=>({url:r.url,method:r.method,purpose:'job_list',http_status:r.http_status,content_type:r.content_type,response_is_json:r.response_is_json,response_file:r.response_file,response_sha256:r.response_sha256,anonymous_session_from_scratch:r.anonymous_session_from_scratch}));

export async function main(){
  const registry=await read(REGISTRY),catalog=await read(CATALOG),candidateData=await read(CANDIDATES),companies=new Map(candidateData.companies.map(x=>[Number(x.waiqi_company_id),x])),items=[],pending=[];
  for(const row of catalog.interfaces){
    if(row.status==='registered_source'||!listPath[row.provider])continue;
    const dir=path.join(ROOT,row.interface_id);let result;try{result=await read(path.join(dir,'result.json'));}catch{continue;}
    if(!result.capability?.list_complete||result.capability.jobs_observed!==0)continue;
    const companyRows=row.waiqi_company_ids.map(id=>companies.get(Number(id))).filter(Boolean),pageMatches=result.identity_page?.name_matches||[],outboundMatches=await outboundEvidence(row,companyRows),crawlMatches=await crawlEvidence(row,companyRows),identityMatches=pageMatches.length?pageMatches:outboundMatches.length?outboundMatches:crawlMatches;
    const matchedIds=[...new Set(identityMatches.map(x=>Number(x.waiqi_company_id)))],matched=matchedIds.map(id=>companies.get(id)).filter(Boolean);
    if(!matched.length){pending.push({interface_id:row.interface_id,provider:row.provider,reason:'official_identity_not_confirmed'});continue;}
    const exactExisting=[...new Set(matched.flatMap(x=>(x.match_evidence||[]).filter(e=>e.basis?.includes('exact_normalized_name')).map(e=>e.company_id)).filter(id=>registry.companies.some(c=>c.company_id===id)))];
    if(exactExisting.length>1){pending.push({interface_id:row.interface_id,provider:row.provider,reason:'multiple_existing_exact_identity_matches'});continue;}
    const identityFile=pageMatches.length?await pageEvidence(dir,result):outboundMatches[0]?.evidence_file||crawlMatches[0]?.evidence_file;if(!identityFile){pending.push({interface_id:row.interface_id,provider:row.provider,reason:'identity_evidence_missing'});continue;}
    const requests=requestEvidence(result);if(!requests.length||requests.some(x=>x.http_status!==200||x.response_is_json!==true||!x.response_file)){pending.push({interface_id:row.interface_id,provider:row.provider,reason:'zero_list_request_evidence_incomplete'});continue;}
    const schema=[...new Set((result.capability.requests||[]).filter(r=>/job_list/i.test(r.purpose||'')).flatMap(r=>r.response_schema_keys||[]))].sort();
    if(!schema.includes(listPath[row.provider])){pending.push({interface_id:row.interface_id,provider:row.provider,reason:'zero_list_schema_not_confirmed'});continue;}
    const examples=(row.request_templates||[]).filter(q=>!/detail/i.test(q.purpose||'')).map(q=>({...q,purpose:'job_list'}));if(!examples.length){pending.push({interface_id:row.interface_id,provider:row.provider,reason:'list_template_missing'});continue;}
    const tags=[...new Set(matched.flatMap(x=>industryMap[x.industry_hint]||[]))];if(!tags.length){pending.push({interface_id:row.interface_id,provider:row.provider,reason:'industry_routing_missing'});continue;}
    const existing=exactExisting[0]&&registry.companies.find(x=>x.company_id===exactExisting[0]),names=[...new Set(identityMatches.map(x=>x.name).filter(Boolean))],display=existing?.display_name||matched[0].display_name,key=sourceKey({provider:row.provider,api_config:row.api_config,primary_entry_url:row.entry_url,validated_api_request_examples:examples}),companyId=existing?.company_id||'waiqi-zero-list-'+hash(key).slice(0,12);
    const identityBasis=pageMatches.length?`Official recruitment entry ${result.identity_page.final_url||result.identity_page.requested_url} contains the reviewed Waiqi name ${names.join(' / ')}.`:outboundMatches.length?`The saved Waiqi company position-list response identifies ${names.join(' / ')} and returns an outsideUrl on this exact provider tenant/site.`:`The reviewed Waiqi official company website identifies ${names.join(' / ')} and its saved career-link crawl reaches this exact recruitment interface.`;
    items.push({company_id:companyId,display_name:display,aliases:names.filter(x=>normalized(x)!==normalized(display)),provider:row.provider,category:(existing?.industry_tags||tags)[0],industry_tags:existing?.industry_tags?.length?[...existing.industry_tags]:tags,primary_entry_url:row.entry_url,api_config:row.api_config,validated_api_request_examples:examples,source_id:'waiqi-zero-list-'+row.interface_id,admitted:true,verification_status:'verified_api_zero_jobs',verified_at:result.checked_at,identity_verification:{identity_verified:true,official_name:display,evidence_file:identityFile,basis:identityBasis},source_verification:{checked_at:result.checked_at,method:'anonymous_official_list_api_zero_jobs_with_explicit_employer_review',complete_jd_samples:0,observed_jobs:0,proof_directory:dir,identity_basis:identityBasis,zero_job_capability:{anonymous:true,credentials_used:false,response_format:'json',list_contract_verified:true,list_items_path:listPath[row.provider],jobs_observed:0,list_complete:true,pages_checked:requests.length,schema_keys:schema,request_evidence:requests}},discovery_provenance:{dataset:'waiqi-company-interface-deep-review',waiqi_company_id:matched[0].waiqi_company_id,related_waiqi_company_ids:matchedIds,interface_id:row.interface_id},merge_group_key:'waiqi-zero-list-'+row.interface_id,suggested_group_display_name:display,...existing?{suggested_existing_company_id:existing.company_id}:{}});
  }
  const plan=planWaiqiIntegration(registry,items.map(item=>({item,file:path.join(ROOT,'zero-admitted.json')})),INDUSTRIES.map(x=>x.id));
  const summary={generated_at:new Date().toISOString(),integration_ready:items.length,pending:pending.length,preview:{added_configurations:plan.added.length,new_companies:plan.added.filter(x=>x.new_company).length,rejected:plan.rejected.length,rejections:plan.rejected},policy:'Only reconciled anonymous JSON list APIs returning zero jobs, with reviewed employer identity. No job detail requested.'};
  await write(path.join(ROOT,'zero-admitted.json'),items);await write(path.join(ROOT,'zero-pending.json'),pending);await write(path.join(ROOT,'zero-preview.json'),summary);console.log(JSON.stringify(summary,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
