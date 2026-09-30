import {createHash} from 'node:crypto';

export const RECRUITMENT_MODES=Object.freeze(['campus','social','internship']);
export const ROUTE_POLICY_VERSION='2026-09-29-explicit-routes-v1';
// These adapters execute the supplied request configuration in every direction.
export const CONFIGURED_ROUTE_PROVIDERS=new Set(['beisen','moka','moka_api_platform','hotjob','feishu','workday','smartrecruiters','greenhouse','ashby','beisen_lightbolt','huawei']);
export const ROUTE_OVERRIDE_FIELDS=Object.freeze(['primary_entry_url','api_config','validated_api_request_examples','public_bootstrap_requests','list_page_size','project_type','official_job_url_template']);
const runtimeFields=['provider','job_namespace','identity_verification',...ROUTE_OVERRIDE_FIELDS];
export const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export function routeRuntimeConfig(source){
  return Object.fromEntries(runtimeFields.filter(k=>source[k]!==undefined).map(k=>[k,k==='identity_verification'?{identity_verified:source[k]?.identity_verified}:['validated_api_request_examples','public_bootstrap_requests'].includes(k)?source[k]?.map(q=>Object.fromEntries(['url','method','headers','body','purpose','response_format','runtime_query_parameters'].filter(key=>q[key]!==undefined).map(key=>[key,q[key]]))):source[k]]));
}
export function routeConfigFingerprint(source){return hash({config:routeRuntimeConfig(source),adapter_route:source.adapter_route||'configured',policy:ROUTE_POLICY_VERSION});}
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
function keys(value,allowed,label){for(const key of Object.keys(value))if(!allowed.includes(key))throw Error('Unknown '+label+' field: '+key);}
export function validateRecruitmentRoutes(source){
  if(!source.collection_routes&&!source.recruitment_modes)return false;
  if(typeof source.source_id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(source.source_id))throw Error('Explicit routes require a stable source_id');
  if(!Array.isArray(source.collection_routes)||!source.collection_routes.length||!source.recruitment_modes)throw Error('Incomplete recruitment route contract');
  const seen=new Map();
  for(const route of source.collection_routes){
    keys(route,['route_id','adapter_route','overrides'],'route');
    if(!id(route.route_id)||seen.has(route.route_id))throw Error('Duplicate or invalid route_id');
    if(!['configured',...RECRUITMENT_MODES].includes(route.adapter_route)||route.adapter_route==='configured'&&!CONFIGURED_ROUTE_PROVIDERS.has(source.provider))throw Error('Unregistered adapter route');
    if(!route.overrides||typeof route.overrides!=='object'||Array.isArray(route.overrides))throw Error('Route overrides must be an object');
    keys(route.overrides,ROUTE_OVERRIDE_FIELDS,'route override');
    if(source.provider==='huawei'&&route.adapter_route==='configured'&&!['CR','SR'].includes((route.overrides.api_config||source.api_config)?.job_type))throw Error('Configured Huawei route requires CR or SR job_type');
    const entry=route.overrides.primary_entry_url??source.primary_entry_url;
    if(!['http:','https:'].includes(new URL(entry).protocol)||new URL(entry).username||new URL(entry).password)throw Error('Invalid route entry URL');
    for(const field of ['validated_api_request_examples','public_bootstrap_requests'])if(route.overrides[field]!==undefined&&!Array.isArray(route.overrides[field]))throw Error('Route request overrides must be arrays');
    const origin=value=>{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('Invalid route request URL');return u.origin;};
    const knownOrigins=new Set([source.primary_entry_url,...source.alternative_entry_urls||[],...source.additional_entry_urls||[],...(source.validated_api_request_examples||[]).map(q=>q.url),...(source.public_bootstrap_requests||[]).map(q=>q.url)].filter(Boolean).map(origin));
    for(const url of [route.overrides.primary_entry_url,route.overrides.api_config?.origin,...(route.overrides.validated_api_request_examples||[]).map(q=>q.url),...(route.overrides.public_bootstrap_requests||[]).map(q=>q.url)].filter(Boolean))if(!knownOrigins.has(origin(url)))throw Error('Unreviewed route origin; register a reviewed source or alias');
    const identityKeys=['tenant','tenant_id','orgId','ctmid','ehire_ctm_id'];
    for(const key of identityKeys)if(source.api_config?.[key]!=null&&route.overrides.api_config?.[key]!=null&&String(source.api_config[key])!==String(route.overrides.api_config[key]))throw Error('Route changes source tenant: '+key);
    const requestBody=q=>{if(typeof q?.body==='object')return q.body||{};try{return JSON.parse(q?.body||'{}');}catch{return Object.fromEntries(new URLSearchParams(q?.body||''));}};
    const original=(source.validated_api_request_examples||[]).map(requestBody),updated=(route.overrides.validated_api_request_examples||[]).map(requestBody);
    for(const key of ['orgId','TenantId','ctmid','ehireCtmId']){const tenants=new Set(original.map(b=>b[key]).filter(v=>v!=null).map(String));if(tenants.size===1&&updated.some(b=>b[key]!=null&&!tenants.has(String(b[key]))))throw Error('Route request changes source tenant: '+key);}
    seen.set(route.route_id,route);
  }
  keys(source.recruitment_modes,RECRUITMENT_MODES,'recruitment mode');
  for(const mode of RECRUITMENT_MODES){
    const binding=source.recruitment_modes[mode];
    if(!binding||!['declared','legacy_unverified','not_supported'].includes(binding.status)||!Array.isArray(binding.route_ids))throw Error('Missing or invalid recruitment mode: '+mode);
    keys(binding,['status','route_ids','scope','limitation','evidence_url'],'mode binding');
    if(new Set(binding.route_ids).size!==binding.route_ids.length)throw Error('Duplicate mode route reference');
    if(binding.status==='not_supported'){
      if(binding.route_ids.length||!/^https?:\/\//.test(binding.evidence_url||'')||!binding.limitation)throw Error('Unsupported direction requires evidence and an empty route list');
    }else if(!binding.route_ids.length)throw Error('Runnable mode has no route');
    for(const rid of binding.route_ids){const route=seen.get(rid);if(!route)throw Error('Dangling route_id: '+rid);if(route.adapter_route!=='configured'&&route.adapter_route!==mode)throw Error('Fixed adapter direction does not match mode');}
  }
  for(const rid of seen.keys())if(!RECRUITMENT_MODES.some(m=>source.recruitment_modes[m].route_ids.includes(rid)))throw Error('Unreferenced route_id: '+rid);
  return true;
}
export function expandRecruitmentRoutes(source,mode){
  if(!RECRUITMENT_MODES.includes(mode))throw Error('Invalid recruitment mode');
  if(source.route_id)return [source];
  if(!validateRecruitmentRoutes(source))return [source];
  const binding=source.recruitment_modes[mode];
  return binding.route_ids.map(rid=>{
    const route=source.collection_routes.find(r=>r.route_id===rid);
    const {collection_routes,recruitment_modes,...base}=source;
    const expanded={...base,...structuredClone(route.overrides),route_id:rid,adapter_route:route.adapter_route,route_status:binding.status,route_scope:binding.scope||'published_route',route_limitation:binding.limitation||null};
    expanded.route_config_fingerprint=routeConfigFingerprint(expanded);return expanded;
  });
}
export function companyRouteEntries(company,mode){
  return (company.recruitment_sources?.length?company.recruitment_sources:[company]).flatMap((parent,index)=>expandRecruitmentRoutes({...parent,company_id:company.company_id,display_name:company.display_name},mode).map(source=>({source,parent,index})));
}
export function recruitmentCoverage(company,mode){
  const sources=company.recruitment_sources?.length?company.recruitment_sources:[company];
  return sources.map(s=>({source_id:s.source_id||null,mode,status:s.recruitment_modes?.[mode]?.status||'legacy_unverified',route_ids:s.recruitment_modes?.[mode]?.route_ids||[],scope:s.recruitment_modes?.[mode]?.scope||'legacy_published_source',limitation:s.recruitment_modes?.[mode]?.limitation||null}));
}
