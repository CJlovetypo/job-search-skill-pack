import {SEARCH_MODE,MODE_POLICY_VERSION} from './search-mode.mjs';

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
 if(source.provider==='moka'||source.provider==='feishu'&&mode==='social')plan.limitation='仅读取已发布入口；当前入口未必完整覆盖本招聘方向。';
 const seen=new Set();return {sources:sources.filter(s=>{const key=JSON.stringify([s.provider,s.primary_entry_url,s.validated_api_request_examples,s.api_config]);if(seen.has(key))return false;seen.add(key);return true;}),plan,requests};
}
