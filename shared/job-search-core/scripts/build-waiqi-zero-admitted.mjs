import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {INDUSTRIES} from './lib/industry-routing.mjs';
import {planWaiqiIntegration} from './lib/waiqi-integration.mjs';

const ROOT=path.resolve('shared/job-search-core/state/maintenance/waiqi-2026-09-20');
const CLEAN=path.join(ROOT,'zero-position-official-clean');
const OUTPUT=path.join(ROOT,'official-zero-api-verification');
const REGISTRY=path.resolve('shared/job-search-core/assets/sources.json');
const DISCOVERY=path.join(ROOT,'zero-position-official-discovery/manifest.json');
const tagById={
  39525:['agriculture'],36526:['smart_hardware'],38720:['finance'],38748:['smart_hardware'],36488:['healthcare'],36091:['internet'],35967:['healthcare'],33379:['supply_chain'],34634:['healthcare'],32141:['supply_chain'],30223:['education'],28433:['logistics_trade'],28342:['energy_environment'],25249:['energy_environment'],25422:['supply_chain'],17458:['materials_chemicals'],16247:['energy_environment'],16017:['construction'],13818:['consumer'],12738:['consumer'],12465:['smart_hardware'],7429:['smart_hardware'],7746:['energy_environment'],9403:['energy_environment'],6906:['internet'],7178:['supply_chain'],7035:['internet'],6712:['industrial'],6708:['consumer'],6650:['telecom'],6150:['supply_chain'],6320:['industrial'],6314:['internet'],6364:['healthcare'],6312:['healthcare'],6013:['supply_chain'],5839:['finance'],5480:['finance'],5751:['consumer'],5799:['energy_environment'],4910:['supply_chain'],5206:['healthcare'],4600:['healthcare'],5195:['healthcare'],4893:['smart_hardware'],5055:['consumer'],4769:['materials_chemicals'],4902:['healthcare'],4635:['healthcare'],4452:['materials_chemicals'],4360:['industrial'],4218:['construction'],4254:['healthcare'],4333:['energy_environment'],2199:['telecom'],1697:['automotive_oem'],2132:['smart_hardware'],1984:['healthcare'],2138:['telecom'],1912:['materials_chemicals'],957:['consumer'],1416:['smart_hardware'],1069:['supply_chain']
};
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const json=async(f,v)=>{await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,JSON.stringify(v,null,2)+'\n');};
const hash=s=>createHash('sha256').update(String(s)).digest('hex');
const requestExample=(r,purpose)=>({url:r.url,method:r.method||'GET',headers:r.headers||{},body:r.body??null,purpose});
const validTags=new Set(INDUSTRIES.map(x=>x.id));

function requestExamples(verification){
  const requests=verification.requests||[],list=requests.find(r=>/mainland.*list/.test(r.purpose||''))||requests.find(r=>/job_list|global_list_with_full_jd|global_list_and_country_facet|global_list_for_mainland_filter/.test(r.purpose||'')),detail=requests.find(r=>/detail/.test(r.purpose||''));
  const examples=[];if(list)examples.push(requestExample(list,'job_list'));if(detail&&detail.url!==list?.url)examples.push(requestExample(detail,'job_detail'));return examples;
}

function canonicalEntry(row){
  const u=new URL(row.primary_entry_url);
  if(row.provider==='beisen')return u.origin+(/campus/i.test(u.pathname)?'/campus/jobs':/social/i.test(u.pathname)?'/social/jobs':'/');
  if(row.provider==='moka'){const m=u.pathname.match(/\/(campus-recruitment|social-recruitment|apply)\/([^/]+)\/(\d+)/i);if(m)return u.origin+'/'+m[1]+'/'+m[2]+'/'+m[3];}
  if(row.provider==='feishu'){const channel=u.pathname.split('/').filter(Boolean)[0]||'index';return u.origin+'/'+channel;}
  u.hash='';return u.href;
}

export async function main(){
  const admitted=await read(path.join(CLEAN,'admitted.json')),cleanPending=await read(path.join(CLEAN,'pending.json')),registry=await read(REGISTRY),manifest=await read(DISCOVERY),manifestById=new Map(manifest.map(x=>[String(x.waiqi_company_id),x]));
  const companies=new Map(registry.companies.map(x=>[x.company_id,x])),pack=[],packagePending=[];
  for(const row of admitted){
    const tags=tagById[row.waiqi_company_id];if(!tags||tags.some(x=>!validTags.has(x))){packagePending.push({...row,package_reason:'industry_routing_not_reviewed'});continue;}
    const verification=await read(path.join(CLEAN,row.verification_file)),sample=row.sample_job,hasComplete=!!sample?.body_complete;
    if(!hasComplete){packagePending.push({...row,package_reason:'no_complete_api_jd_for_planWaiqiIntegration'});continue;}
    const matched=(row.matched_company_ids||[]).filter(x=>companies.has(x)),suggested=matched.length===1?matched[0]:null;if(matched.length>1){packagePending.push({...row,package_reason:'multiple_existing_company_identity_hints'});continue;}
    const existing=suggested?companies.get(suggested):null,display=String(row.display_name).normalize('NFKC').trim(),companyId=suggested||'company-'+hash(row.context_key).slice(0,12),sourceId='waiqi-zero-20260920-'+hash(row.context_key).slice(0,12),evidence=manifestById.get(String(row.waiqi_company_id)),identityFile=evidence?.homepage?.response_file||evidence?.requests?.find(x=>x.purpose==='supplier_website_homepage')?.response_file;
    if(!identityFile){packagePending.push({...row,package_reason:'missing_official_website_identity_file'});continue;}
    const providerSource=verification.source||{},apiConfig=row.api_config||providerSource.api_config,examples=requestExamples(verification);if(!examples.length){packagePending.push({...row,package_reason:'missing_replayable_verified_api_request'});continue;}
    const aliases=[...new Set((row.aliases||[]).map(x=>String(x).normalize('NFKC').trim()).filter(Boolean))],identityBasis=`Official website chain ${row.official_chain?.join(' -> ')}; ATS employer/tenant evidence: ${(row.employer_names||[]).map(x=>typeof x==='string'?x:x?.name||x?.descriptor).filter(Boolean).join(' / ')||row.context_key}`;
    const item={company_id:companyId,display_name:display,aliases,provider:row.provider,category:tags[0],industry_tags:tags,industry_assignment:{status:'reviewed_routing',basis:'Manual routing from the verified employer business and official recruitment context.'},primary_entry_url:canonicalEntry(row),...apiConfig?{api_config:apiConfig}:{},validated_api_request_examples:examples,...providerSource.public_bootstrap_requests?{public_bootstrap_requests:providerSource.public_bootstrap_requests}:{},source_id:sourceId,admitted:true,verification_status:'verified_api_full_jd',verified_at:row.verified_at,identity_verification:{identity_verified:true,official_name:display,evidence_file:identityFile,basis:identityBasis},source_verification:{checked_at:row.verified_at,method:row.mainland_total>0?'official_mainland_list_and_one_complete_jd':'official_api_global_full_jd_with_mainland_scope_checked_empty',complete_jd_samples:1,observed_jobs:Number(row.mainland_total)>0?Number(row.mainland_total):Number(row.global_total||1),proof_directory:path.resolve(CLEAN,path.dirname(row.verification_file)),identity_basis:identityBasis,scope:row.mainland_total>0?'Mainland China list; one complete JD sample':'Mainland China scope checked with no current matches; one global complete JD proves API capability and employer identity.',pagination:'Capability validation; inventory completeness is not claimed.'},discovery_provenance:{dataset:'waiqi-zero-position-official-discovery-20260920',waiqi_company_id:row.waiqi_company_id,official_chain:row.official_chain,context_key:row.context_key},verified_samples:[sample],merge_group_key:'waiqi-zero-company-'+row.waiqi_company_id,suggested_group_display_name:display,...suggested?{suggested_existing_company_id:suggested}:{}};
    // Preserve reviewed routing already attached to an existing company and avoid adding an unrelated tag through a supplementary source.
    if(existing?.industry_tags?.length)item.industry_tags=[...existing.industry_tags];
    pack.push(item);
  }
  const {added,skipped,rejected}=planWaiqiIntegration(registry,pack.map(item=>({item,file:path.join(OUTPUT,'admitted.json')})),INDUSTRIES.map(x=>x.id));
  const summary={generated_at:new Date().toISOString(),strict_clean_admitted:admitted.length,integration_ready:pack.length,package_pending:packagePending.length,clean_pending:cleanPending.length,preview:{added_configurations:added.length,new_companies:added.filter(x=>x.new_company).length,already_registered:skipped.length,rejected:rejected.length,rejections:rejected},policy:'Preview only. sources.json and metadata registries were not modified.'};
  await json(path.join(OUTPUT,'admitted.json'),pack);await json(path.join(OUTPUT,'pending.json'),[...cleanPending,...packagePending]);await json(path.join(OUTPUT,'preview.json'),summary);console.log(JSON.stringify(summary,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
