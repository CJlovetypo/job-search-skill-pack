import {assertAutomaticRepair} from './repair-policy.mjs';
import {publicUrl} from './public-company-data.mjs';
import {queueKeywordReviews} from './source-keyword-maintenance.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {CORE_ROOT} from '../../runtime-context.mjs';
import {SOURCE_REGISTRY_FILE} from '../../registry.mjs';
import {createClient} from './http.mjs';
import {publicSiteConfig,requestObject} from './source-directions.mjs';
import {mokaSiteCandidates,confirmMokaSiteCandidate} from './public-site-candidates.mjs';
import {SEARCH_MODE} from './search-mode.mjs';

const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
export const repairConfigKey=s=>createHash('sha256').update(JSON.stringify(stable({company_id:s.company_id,source_id:s.source_id,identity_verified:s.identity_verification?.identity_verified,provider:s.provider,entry:s.primary_entry_url,api_config:s.api_config,requests:s.validated_api_request_examples}))).digest('hex').slice(0,24);
const save=async(p,v)=>{await fs.mkdir(path.dirname(p),{recursive:true});const temp=p+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(v,null,2)+'\n');for(let i=0;;i++){try{await fs.rename(temp,p);return;}catch(e){if(i>=6)throw e;await new Promise(r=>setTimeout(r,100*(i+1)));}}};
const read=async(p,d=null)=>{try{return JSON.parse(await fs.readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return d;throw e;}};
export function sourceFailureKind(result){
 const text=String(result?.coverage?.reason||''),codes=(result?.requests||[]).map(r=>r.http_status);
 if(codes.includes(429)||/429|rate.?limit|限流/i.test(text))return 'rate_limited';
 if(codes.some(c=>[401,403].includes(c))||/captcha|登录|验证码|unauthorized/i.test(text))return 'access_restricted';
 if(result?.coverage?.status==='complete')return result.jobs?.length?'healthy':'empty';
 if(/timeout|timed.?out|deadline|fetch failed|ECONN|ENOTFOUND/i.test(text))return 'transient_network';
 if(codes.some(c=>[404,410].includes(c))||/404|410|missing|expected|schema|invalid.*(?:site|tenant|project)|not.*(?:json|found)|配置|结构|字段/i.test(text))return 'contract_changed';
 return result?.coverage?.status==='failed'?'unclassified_failure':'partial';
}
export function repairCandidateAccepted(old,candidate,result,identity){
 if(!identity?.accepted)return {accepted:false,reason:identity?.reason||'identity_not_confirmed'};
 if(old.provider!==candidate.provider)return {accepted:false,reason:'provider_migration_requires_review'};
 const jobs=(result?.jobs||[]).filter(j=>j.body_complete&&j.job_id&&j.official_url);
 if(!jobs.length)return {accepted:false,reason:'no_complete_jd_for_new_contract'};
 if(sourceFailureKind(result)==='access_restricted')return {accepted:false,reason:'access_restricted'};
 return {accepted:true,reason:'same_public_tenant_and_channel_with_complete_api_jd',jobs:jobs.length};
}
export async function discoverRepairCandidates(source,options={}){
 const client=options.client||createClient(options),candidates=[],notes=[];
 const entries=[...new Set([source.primary_entry_url,...source.alternative_entry_urls||[]])].slice(0,3),original=new URL(source.primary_entry_url);
 const list=source.validated_api_request_examples?.find(q=>/job_list|list/i.test(q.purpose||'')),known=requestObject(list||{});
 const mokaChannel=['social-recruitment','apply'].includes(known.site)?'social-recruitment':'campus-recruitment';
 const change=(entry,route,identity,evidence)=>{
  if(source.provider==='moka'&&(route.site!==mokaChannel||String(route.siteId)===String(known.siteId)&&new URL(entry).origin===original.origin))return;
  if(source.provider==='feishu'&&route.websitePath===list?.headers?.['website-path']&&entry===source.primary_entry_url)return;
  const s=structuredClone(source),origin=new URL(entry).origin;s.primary_entry_url=entry;s.public_bootstrap_requests=[{url:entry,method:'GET',purpose:'public_configuration_bootstrap'}];
  for(const q of s.validated_api_request_examples||[]){const u=new URL(q.url);q.url=origin+u.pathname+u.search;q.headers={...q.headers,Origin:origin,Referer:entry};if(s.provider==='moka'&&/\/website\/jobs\/v2/.test(q.url))q.body={...requestObject(q),orgId:route.orgId,siteId:route.siteId,site:route.site};if(s.provider==='feishu')q.headers['website-path']=route.websitePath;}
  if(repairConfigKey(s)!==repairConfigKey(source))candidates.push({source:s,identity,evidence});
 };
 for(const entry of entries){
  try{const boot=await client.request({url:entry},{purpose:'repair_public_configuration_bootstrap'});if(boot.record.http_status!==200){notes.push('entry_http_'+boot.record.http_status);continue;}
   if(source.provider==='moka'){
    const config=publicSiteConfig(boot.text,'moka'),org=String(known.orgId||''),mode=mokaChannel==='social-recruitment'?'social':'campus';
    const found=mokaSiteCandidates(config,{entryUrl:boot.url,orgId:org,mode,evidenceFile:boot.record.response_file});notes.push(...found.notes);
    const disclosedId=config?.siteId??config?.org?.siteId,disclosedType=config?.mode||config?.org?.type;
    if(String(config?.org?.id||'')===org&&disclosedId&&['social','camp','campus'].includes(disclosedType)){
     const site=disclosedType==='social'?'social-recruitment':'campus-recruitment';if(site===mokaChannel)found.routes.unshift({entry:new URL('/'+site+'/'+encodeURIComponent(org)+'/'+encodeURIComponent(disclosedId),boot.url).href,site,orgId:org,siteId:String(disclosedId),repair_binding:'public_current_configuration'});
    }
    // A redirected public page is also an observed candidate, never a guessed year/ID.
    const match=new URL(boot.url).pathname.match(/^\/(campus-recruitment|social-recruitment)\/([^/]+)\/([^/]+)/);
    if(match&&match[2]===org)found.routes.unshift({entry:boot.url,site:match[1],orgId:org,siteId:match[3],repair_binding:'public_redirect'});
    const uniqueRoutes=[...new Map(found.routes.map(r=>r.entry).map(entry=>[entry,found.routes.find(r=>r.entry===entry)])).values()];
    for(const route of uniqueRoutes.slice(0,3)){const target=route.entry===boot.url?boot:await client.request({url:route.entry},{purpose:'repair_candidate_bootstrap'});if(target.record.http_status!==200)continue;const proof=confirmMokaSiteCandidate(route,publicSiteConfig(target.text,'moka'));if(proof.accepted)change(route.entry,route,proof,{discovery_file:boot.record.response_file,confirmation_file:target.record.response_file,kind:route.repair_binding||'public_project_rotation'});else notes.push(proof.reason);}
   }else if(source.provider==='feishu'){
    const cfg=publicSiteConfig(boot.text,'feishu'),tenant=cfg?.tenant_info?.tenant_id_md5||cfg?.tenant_info?.tenant_id,expected=source.identity?.tenant_id,websitePath=cfg?.website_info?.path;
    if(websitePath&&new URL(boot.url).origin===original.origin&&(!expected||String(expected)===String(tenant)))change(boot.url,{websitePath},{accepted:true,reason:'same_verified_tenant_origin_public_website_path'},{confirmation_file:boot.record.response_file,tenant_id:tenant,kind:'public_website_path_rotation'});
   }else if(source.provider==='beisen'){
    if(new URL(boot.url).origin!==original.origin){notes.push('redirected_domain_requires_employer_review');continue;}
    const observed=[...boot.text.matchAll(/(?:https?:)?\/\/[^\s"'<>\\]+/g)].map(m=>m[0]);
    const scripts=[...boot.text.matchAll(/<script[^>]+src=["']([^"']+)/gi)].map(m=>new URL(m[1],boot.url).href).filter(u=>new URL(u).origin===original.origin).slice(0,2);
    for(const url of scripts){const r=await client.request({url},{purpose:'repair_public_frontend_contract'});if(r.record.http_status===200)observed.push(...[...r.text.matchAll(/(?:baseURL|baseUrl|apiBase|apiHost)\s*[:=]\s*["'](https?:\/\/[^"']+)/g)].map(m=>m[1]));}
    for(const url of [...new Set(observed)]){try{const u=new URL(url,boot.url);if(u.origin!==original.origin)notes.push('observed_gateway_requires_identity_review:'+u.origin);}catch{}}
   }else notes.push('automatic_parameter_repair_not_implemented_for_'+source.provider);
  }catch(e){notes.push(e.message);}
 }
 return {candidates:[...new Map(candidates.map(c=>[repairConfigKey(c.source),c])).values()].slice(0,3),notes:[...new Set(notes)],requests:client.records};
}
export async function commitSourceRepair(old,candidate,evidence,{registryFile=SOURCE_REGISTRY_FILE,append=false,access,verification}={}){
 if(access==='safe_existing'){if(append)throw Error('automatic_repair_cannot_append');assertAutomaticRepair(old,candidate,verification);}
 else if(access!=='maintenance')throw Error('修复写入需要明确 safe_existing 或 maintenance 策略');
 const lock=registryFile+'.repair.lock';let handle;
 for(let n=0;n<50;n++){try{handle=await fs.open(lock,'wx');break;}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,100));}}
 if(!handle)return {updated:false,reason:'registry_busy'};
 try{
  const registry=await read(registryFile),company=registry.companies.find(c=>c.company_id===old.company_id);if(!company)return {updated:false,reason:'company_missing'};
  const beforeRegistry=structuredClone(registry),configs=company.recruitment_sources?.length?company.recruitment_sources:[company];
  const index=configs.findIndex(s=>repairConfigKey({...s,company_id:company.company_id})===repairConfigKey(old));if(index<0)return {updated:false,reason:'configuration_changed_concurrently'};
  const previous=configs[index];
  if(access==='safe_existing')assertAutomaticRepair({...previous,company_id:company.company_id,display_name:company.display_name},{...candidate,company_id:company.company_id,display_name:company.display_name},verification);
  if(append){
   if(!candidate.source_id||candidate.company_id!==company.company_id)return {updated:false,reason:'new_source_identity_required'};
   if(configs.some(s=>s.source_id===candidate.source_id||s.provider===candidate.provider&&s.primary_entry_url===candidate.primary_entry_url))return {updated:false,reason:'source_already_present'};
  }
  const id=randomUUID(),folder=path.resolve(registryFile)===path.resolve(SOURCE_REGISTRY_FILE)?path.join(CORE_ROOT,'state/source-repairs'):registryFile+'.repairs',recordFile=path.join(folder,id+'.json');
  const summary={repair_id:id,checked_at:new Date().toISOString(),kind:access,previous_fingerprint:repairConfigKey(old),current_fingerprint:repairConfigKey(candidate),scope:verification?.mode||'maintenance',validation:'sample_only',evidence_urls:[...new Set([old.primary_entry_url,candidate.primary_entry_url].map(publicUrl).filter(Boolean))]};
  const history=(previous.repair_history||[]).map(h=>({...Object.fromEntries(['repair_id','checked_at','kind','previous_fingerprint','current_fingerprint','scope','validation'].filter(k=>h[k]!==undefined).map(k=>[k,h[k]])),repair_id:h.repair_id||'legacy',kind:h.kind||'legacy_archived',evidence_urls:(h.evidence_urls||[]).map(publicUrl).filter(Boolean)}));
  let next=access==='safe_existing'?{...previous,primary_entry_url:candidate.primary_entry_url,validated_api_request_examples:candidate.validated_api_request_examples,public_bootstrap_requests:candidate.public_bootstrap_requests}:{...previous,...candidate};
  delete next.target_mode;delete next.direction_route_evidence;next.repair_history=[...history,summary];
  if(append){next={...candidate,repair_history:[summary]};delete next.target_mode;delete next.direction_route_evidence;const existing=configs.map((s,i)=>{const copy=structuredClone(s);delete copy.recruitment_sources;copy.source_id??=String(i);return copy;});company.recruitment_sources=[...existing,next];}
  else if(company.recruitment_sources?.length){company.recruitment_sources[index]=next; if(index===0)for(const k of access==='safe_existing'?['primary_entry_url','validated_api_request_examples','public_bootstrap_requests']:['verification_status','verified_at','source_verification','verified_samples','identity_verification','admitted','provider','primary_entry_url','api_config','validated_api_request_examples','public_bootstrap_requests'])if(next[k]!==undefined)company[k]=next[k];}
  else Object.assign(company,next);
  const digest=x=>createHash('sha256').update(JSON.stringify(stable(x))).digest('hex');
  const record={id,status:'prepared',registry_file:path.resolve(registryFile),before_hash:digest(beforeRegistry),after_hash:digest(registry),before_registry:beforeRegistry,after_registry:registry,evidence,verification,created_at:summary.checked_at};
  await save(recordFile,record);
  const keyword_review=await queueKeywordReviews(beforeRegistry,registry,{registryFile});
  if(digest(await read(registryFile))!==record.before_hash)return {updated:false,reason:'configuration_changed_concurrently',record:recordFile};
  await save(registryFile,registry);await save(recordFile,{...record,status:'committed'});
  return {updated:true,company_id:company.company_id,source_id:next.source_id,appended:append,keyword_review,record:recordFile,effective_source:{...next,company_id:company.company_id,display_name:company.display_name}};
 }finally{await handle.close();await fs.unlink(lock).catch(()=>{});}
}
export async function recoverSourceRepair(recordFile,{rollback=false,registryFile=SOURCE_REGISTRY_FILE}={}){
 const record=await read(recordFile);if(!record||record.registry_file!==path.resolve(registryFile))throw Error('修复记录不属于目标来源库');
 const lock=registryFile+'.repair.lock',handle=await fs.open(lock,'wx');
 try{const digest=x=>createHash('sha256').update(JSON.stringify(stable(x))).digest('hex');
  if(digest(record.before_registry)!==record.before_hash||digest(record.after_registry)!==record.after_hash)throw Error('修复恢复记录哈希不一致');
  const current=await read(registryFile),actual=digest(current);if(![record.before_hash,record.after_hash].includes(actual))throw Error('来源库已变化，不能用旧修复记录覆盖');
  const desired=rollback?record.before_registry:record.after_registry;await queueKeywordReviews(current,desired,{registryFile});
  if(digest(desired)!==actual)await save(registryFile,desired);
  await save(recordFile,{...record,status:rollback?'rolled_back':'committed'});return {status:rollback?'rolled_back':'committed',record:recordFile};
 }finally{await handle.close();await fs.unlink(lock);}
}
export async function maintainSource(source,result,options,collector){
 if(options.repair===false||options.repairPolicy==='off')return result;
 const key=repairConfigKey(source),mode=options.targetMode||SEARCH_MODE.id,stateFile=path.join(CORE_ROOT,'state/source-health',key+'-'+mode+'.json'),previous=await read(stateFile,{}),now=new Date().toISOString(),kind=sourceFailureKind(result);
 const schema=(result.requests||[]).filter(q=>/list|detail/.test(q.purpose||'')).map(q=>({url:new URL(q.url).pathname,keys:q.response_schema_keys||[]}));
 const health={...previous,key,company_id:source.company_id,provider:source.provider,entry_url:source.primary_entry_url,mode,checked_at:now,status:kind,last_success_at:['healthy','empty'].includes(kind)?now:previous.last_success_at||null,last_failure:['healthy','empty'].includes(kind)?null:kind,consecutive_failures:['healthy','empty'].includes(kind)?0:(previous.consecutive_failures||0)+1,jobs:result.jobs?.length||0,list_observed:!!result.coverage?.pages,full_jds:(result.jobs||[]).filter(j=>j.body_complete).length,pagination:result.coverage?.status,schema_fingerprint:createHash('sha256').update(JSON.stringify(schema)).digest('hex')};
 const cooldown=previous.last_repair_at&&Date.now()-Date.parse(previous.last_repair_at)<6*3600000;
 if(!['rate_limited','access_restricted'].includes(kind)&&(kind==='contract_changed'||options.forceRepair)&&(!cooldown||options.forceRepair)){
  health.last_repair_at=now;health.repair=null;const repairDir=options.evidenceDir?path.join(options.evidenceDir,'repair'):path.join(CORE_ROOT,'state/repair-evidence',key+'-'+mode,now.replace(/[:.]/g,'-'));
  const repairOpts={...options,mode:'full',maxPages:1,maxDetails:3,timeoutMs:7000,repair:false,signal:AbortSignal.timeout(30000),requestBudget:{remaining:20},keyword:'',titleFilter:undefined,evidenceDir:repairDir};
  const discovery=await discoverRepairCandidates(source,repairOpts);await save(path.join(repairDir,'discovery.json'),discovery);const attempts=[];
  const bound=discovery.candidates.filter(c=>['public_redirect','public_current_configuration'].includes(c.evidence.kind));
  const candidates=bound.length===1?bound:discovery.candidates.length===1?discovery.candidates:[];
  if(!candidates.length&&discovery.candidates.length>1)discovery.notes.push('multiple_possible_replacement_projects_require_review');
  for(const candidate of candidates){try{const check=await collector(candidate.source,repairOpts),proof=repairCandidateAccepted(source,candidate.source,check,candidate.identity);await save(path.join(repairDir,'verification-'+repairConfigKey(candidate.source)+'.json'),{source:candidate.source,proof,result:check});attempts.push({...candidate.evidence,entry:candidate.source.primary_entry_url,...proof});if(!proof.accepted)continue;
    const committed=await commitSourceRepair(source,candidate.source,{...candidate.evidence,...proof},{registryFile:options.registryFile||SOURCE_REGISTRY_FILE,access:'safe_existing',verification:{identity:candidate.identity,result:check,mode,kind:candidate.evidence.kind}});if(!committed.updated){attempts.at(-1).reason=committed.reason;continue;}
    health.repair={status:'adopted',keyword_review:committed.keyword_review,previous_entry:source.primary_entry_url,current_entry:candidate.source.primary_entry_url,evidence:candidate.evidence,proof};
    // Verification is a small sample. Re-run the user's original query before returning.
    let repaired;try{repaired=await collector(candidate.source,{...options,repair:false});}catch(e){repaired={jobs:[],requests:[],coverage:{status:'failed',pages:0,reason:'repaired_contract_recollection_failed: '+e.message}};}
    result={...repaired,repair:health.repair,effective_source:committed.effective_source};break;
   }catch(e){attempts.push({entry:candidate.source.primary_entry_url,accepted:false,reason:e.message});}}
  health.repair||={status:'needs_rediscovery',notes:discovery.notes,attempts};result.repair||=health.repair;
 }
 await save(stateFile,health);return result;
}
