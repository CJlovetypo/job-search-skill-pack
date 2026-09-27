import {createHash} from 'node:crypto';
import path from 'node:path';
import {createClient} from './http.mjs';
import {SKILL_ROOT,readJson,writeJson} from './io.mjs';
import {runtimeContext} from '../../runtime-context.mjs';
import {SEARCH_MODE,MODE_POLICY_VERSION} from './search-mode.mjs';
import {mokaSiteCandidates,confirmMokaSiteCandidate} from './public-site-candidates.mjs';

const clone=x=>structuredClone(x);
export function requestObject(q) {
 if(q.body&&typeof q.body==='object')return clone(q.body);
 if(typeof q.body==='string'){try{return JSON.parse(q.body);}catch{return Object.fromEntries(new URLSearchParams(q.body));}}
 return {};
}
const decode=s=>s.replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
export function publicSiteConfig(html,provider) {
 if(provider==='moka') {
  for(const m of html.matchAll(/<input\b[^>]*>/gi))if(/\bid\s*=\s*["']init-data["']/i.test(m[0])) {
   const v=m[0].match(/\bvalue\s*=\s*(["'])([\s\S]*?)\1/i)?.[2];if(v)return JSON.parse(decode(v));
  }
 }else {
  for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(/\bid=["']js-websiteInfo["']/.test(m[1]))return JSON.parse(m[2]);
 }
 return null;
}
function strings(v) { return typeof v==='string'?[v]:Array.isArray(v)?v.flatMap(strings):v&&typeof v==='object'?Object.values(v).flatMap(strings):[]; }
const broadProviders=new Set(['iqvia_public','ajinga_public','jobs2web_public','tupu360','moseeker_public','phenom_public','eightfold_public','avature_public','51job_coapi','51job_xyz','zhaopin_grace','workday','smartrecruiters','icims_jibe','oracle_recruiting','nowcoder_public','greenhouse','ashby','microsoft_eightfold','sap_rss','amazon_jobs','xinrenxinshi','yotta','tongcheng','wenhua_public']);
export function sourceDirectionPlan(source,mode=SEARCH_MODE.id) {
 if(source.provider==='huatie_public')return {strategy:'official_career_channel',scope:mode==='internship'?'campus_portal_without_dedicated_internship_channel':'observed_official_channel',...(mode==='internship'?{limitation:'官网仅公开校招和社招入口，实习读取校招门户，不能证明全公司实习覆盖。'}:{})};
 if(mode==='campus')return {strategy:'verified_campus',scope:'verified_original'};
 if(['tencent','alibaba','baidu','jd','bilibili','kuaishou','xiaohongshu'].includes(source.provider)||mode==='internship'&&source.provider==='pdd')return {strategy:'verified_employer_direction_contract',scope:'per_job_type_required'};
 if(['beisen','beisen_lightbolt','hotjob','feishu','moka','moka_api_platform','hcmcloud_public'].includes(source.provider))return {strategy:'public_type_routing',scope:'validate_target_at_runtime'};
 if(broadProviders.has(source.provider))return {strategy:'existing_broad_stream',scope:'per_job_type_required'};
 if(['meituan','openout'].includes(source.provider)||source.provider==='first_party'&&/shein|ctrip/.test(source.primary_entry_url||'')||source.provider==='cec_campus'&&mode==='social')return {strategy:'verified_custom_type_routing',scope:'validate_target_at_runtime'};
 return {strategy:'inherited_stream',scope:'target_channel_not_verified',limitation:'已继承并读取原公开接口；尚未证明该入口完整覆盖本招聘方向，未返回目标岗位不代表公司没有招聘。'};
}

/** Change only documented filters; a changed query never proves a returned job's type. */
export function routeKnownSource(source,mode) {
 const s=clone(source);s.target_mode=mode;
 if(s.provider==='beisen_lightbolt')s.api_config={...s.api_config,categories:mode==='social'?[1]:[1,2,3]};
 if(s.provider==='hcmcloud_public')s.api_config={...s.api_config,target_mode:mode};
 if(s.provider==='cec_campus'&&mode==='social')s.api_config={...s.api_config,query:{...s.api_config?.query,positionType:1}};
 if(s.provider==='ccb_public'&&mode==='internship')s.api_config={...s.api_config,query:{...s.api_config?.query,planType:'SX'}};
 for(const q of s.validated_api_request_examples||[]) {
  if(s.provider==='beisen'&&/GetJobAdPageList/i.test(q.url)) { q.body={...requestObject(q),Category:mode==='social'?['1']:['1','2','3']};delete q.body.Kind; }
  if(s.provider==='feishu'&&/\/search\/job\/posts/.test(q.url))q.body={...requestObject(q),recruitment_id_list:[]};
  if(s.provider==='hotjob'&&/\/listPosition\//.test(q.url)) {
   // Official Hotjob mc/index.js maps intern <-> 12 (实习生招聘).
   // This selects a query channel only; actual returned fields prove job type.
   const b=requestObject(q);q.body=new URLSearchParams({...b,recruitType:mode==='social'?'2':mode==='internship'?'12':String(b.recruitType||1)}).toString();
  }
  if(s.provider==='moka_api_platform') {const u=new URL(q.url);u.searchParams.set('mode',mode==='social'?'social':'campus');q.url=u.href;}
 }
 return s;
}

async function discoverSites(source,options) {
 const mode=options.targetMode,sourceKey=JSON.stringify([MODE_POLICY_VERSION,'public-site-tuples-v2',mode,source.provider,source.primary_entry_url,source.validated_api_request_examples]);
 const key=createHash('sha256').update(sourceKey).digest('hex');
 if(options.directionDiscoveryMemo?.has(key))return {...clone(options.directionDiscoveryMemo.get(key)),audit_scope_reused:true};
 const cache=path.join(options.cacheRoot||runtimeContext().cacheRoot,key+'.json');
 const cached=options.refresh?null:await readJson(cache,null);
 if(cached){options.directionDiscoveryMemo?.set(key,clone(cached));return {...cached,cache_reused:true};}
 const client=options.discoveryClient||createClient({...options,evidenceDir:options.evidenceDir?path.join(options.evidenceDir,'channel-discovery'):undefined});
 const result={routes:[],notes:[],requests:[],checked_at:new Date().toISOString()};
 try {
  const boot=await client.request({url:source.primary_entry_url},{purpose:'public_configuration_bootstrap'});
  if(boot.record.http_status!==200)throw Error('Public configuration HTTP '+boot.record.http_status);
  const config=publicSiteConfig(boot.text,source.provider);
  if(source.provider==='moka') {
   const list=(source.validated_api_request_examples||[]).find(q=>/\/website\/jobs\/v2/.test(q.url));
   const org=String(requestObject(list||{}).orgId||'');
   if(!config||!org)throw Error('Missing public Moka configuration or verified tenant');
   const candidates=mokaSiteCandidates(config,{entryUrl:boot.url,orgId:org,mode,evidenceFile:boot.record.response_file});result.notes.push(...candidates.notes);
   for(const route of candidates.routes){
    try{
     const same=route.entry===new URL(boot.url).origin+new URL(boot.url).pathname.replace(/\/$/,'');
     const target=same?boot:await client.request({url:route.entry},{purpose:'public_related_site_configuration'});
     if(target.record.http_status!==200){result.notes.push('Related site HTTP '+target.record.http_status);continue;}
     const confirmation=confirmMokaSiteCandidate(route,same?config:publicSiteConfig(target.text,'moka'));
     if(confirmation.accepted)result.routes.push({...route,requires_bootstrap_identity_check:false,confirmation,confirmation_file:target.record.response_file});
     else result.notes.push(confirmation.reason);
    }catch(error){result.notes.push(error.message);}
   }
  }else {
   const links=[...boot.text.matchAll(/href\s*=\s*(["'])(.*?)\1/gi)].map(m=>decode(m[2]))
     .concat(strings(config).flatMap(v=>v.match(/(?:https?:)?\/\/[^\s"'<>]+/g)||[]));
   const candidates=[...new Set(links.filter(v=>/social|society|experienced/i.test(v)).map(v=>{try{return new URL(v,boot.url).href;}catch{return null;}}).filter(Boolean))];
   // New hosts require separate company identity verification; stay on this public tenant.
   for(const url of candidates.filter(u=>new URL(u).origin===new URL(boot.url).origin).slice(0,4)) {
    const r=await client.request({url},{purpose:'public_related_site_configuration'});if(r.record.http_status!==200)continue;
    const info=publicSiteConfig(r.text,'feishu'),websitePath=info?.website_info?.path;
    if(!websitePath)continue;
    const tenant=x=>x?.tenant_info?.tenant_id_md5||x?.tenant_info?.tenant_id;
    if(tenant(config)&&tenant(info)&&tenant(config)!==tenant(info)){result.notes.push('Linked website tenant differs; not adopted');continue;}
    const u=new URL(r.url);const prefix=u.pathname.split('/').filter(Boolean)[0];
    const office=websitePath==='society';
    result.routes.push({entry:u.origin+'/'+(prefix?prefix+'/':''),websitePath,office,evidence_file:r.record.response_file});
   }
  }
 }catch(error){result.notes.push(error.message);}
 result.requests=client.records;
 // Failed discovery is retried on next run, not cached as a permanent absence.
 if(!result.notes.length)await writeJson(cache,result);
 options.directionDiscoveryMemo?.set(key,clone(result));
 return result;
}

export async function directionSources(source,options={}) {
 const mode=options.targetMode||SEARCH_MODE.id,plan=sourceDirectionPlan(source,mode);
 if(mode==='campus')return {sources:[source],plan,requests:[]};
 const base=routeKnownSource(source,mode),sources=[base],requests=[];
 // Capability verification can address a documented target category directly;
 // regular collection retains its broad stream to include internships filed elsewhere.
 if(options.preferTargetTypes&&mode==='internship')for(const q of base.validated_api_request_examples||[]){
  if(source.provider==='beisen'&&/GetJobAdPageList/i.test(q.url))q.body={...requestObject(q),Category:['3']};
  if(source.provider==='feishu'&&/\/search\/job\/posts/.test(q.url))q.body={...requestObject(q),recruitment_id_list:['202']};
 }
 if(source.provider==='hotjob'&&mode==='internship') {
  // Internships may also be filed under the campus or social channels. Keep
  // both compatibility streams after the verified dedicated internship query.
  const campus=clone(base);
  for(const q of campus.validated_api_request_examples||[])if(/\/listPosition\//.test(q.url))q.body=new URLSearchParams({...requestObject(q),recruitType:'1'}).toString();
  sources.push(campus);
 }
 if(['hotjob','moka_api_platform','hcmcloud_public'].includes(source.provider)&&mode==='internship') {
  const social=routeKnownSource(source,'social');social.target_mode=mode;sources.push(social);
 }
 if(source.provider==='moka'||source.provider==='feishu'&&mode==='social') {
  const discovery=await discoverSites(source,{...options,targetMode:mode});requests.push(...discovery.requests);
  for(const route of discovery.routes) {
   const s=clone(base),origin=new URL(route.entry).origin;s.primary_entry_url=route.entry;s.direction_route_evidence=route;
   if(source.provider==='moka') {
    s.public_bootstrap_requests=[{url:route.entry,method:'GET'}];
    for(const q of s.validated_api_request_examples||[]) {
     const u=new URL(q.url);q.url=origin+u.pathname+u.search;
     q.headers={...q.headers,Origin:origin,Referer:route.entry};
     if(/\/website\/jobs\/v2/.test(q.url))q.body={...requestObject(q),orgId:route.orgId,siteId:route.siteId,site:route.site};
    }
   }else {
    const rewrite=q=>{const u=new URL(q.url);q.url=origin+u.pathname+u.search;q.headers={...q.headers,Origin:origin,Referer:route.entry,'website-path':route.websitePath,...route.office?{'portal-channel':'office'}:{}};
     if(/\/search\/job\/posts/.test(q.url))q.body={...requestObject(q),recruitment_id_list:[],...route.office?{portal_type:2}:{}};return q;};
    s.validated_api_request_examples=(s.validated_api_request_examples||[]).map(rewrite);
    s.public_bootstrap_requests=(s.public_bootstrap_requests||[]).map(rewrite);
    s.official_job_url_template=route.entry.replace(/\/$/,'')+'/position/{job_id}/detail';
   }
   sources.push(s);
  }
  plan.discovery_notes=discovery.notes;
  if(mode==='social'&&!discovery.routes.length&&/campus/.test(source.primary_entry_url||''))plan.limitation='当前已验证入口属于校招门户，公开配置尚未定位社招门户；本入口结果不能证明该公司没有社招。';
 }
 const seen=new Set();return {sources:sources.filter(s=>{const key=JSON.stringify([s.provider,s.primary_entry_url,s.validated_api_request_examples,s.api_config]);if(seen.has(key))return false;seen.add(key);return true;}),plan,requests};
}
