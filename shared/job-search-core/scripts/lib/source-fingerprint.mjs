import {companyRouteEntries,routeConfigFingerprint,recruitmentCoverage} from './recruitment-routes.mjs';
import {createHash} from 'node:crypto';
import {SEARCH_MODE,MODE_POLICY_VERSION} from './search-mode.mjs';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const revisedProviders=new Set(['huawei','workday','oracle_recruiting','sap_rss','greenhouse','ashby']);
export function sourceConfigFingerprint(company,targetMode=SEARCH_MODE.id){
 const providers=(company.recruitment_sources?.length?company.recruitment_sources:[company]).map(s=>s.provider);
 const collectorRevision=providers.some(p=>revisedProviders.has(p))?'2026-09-30-entry-body-location-repairs':undefined;
 if(company.collection_routes||company.recruitment_sources?.some(s=>s.collection_routes))return createHash('sha256').update(JSON.stringify(canonical({collectorRevision,targetMode,policy:MODE_POLICY_VERSION,routes:companyRouteEntries(company,targetMode).map(({source})=>({source_id:source.source_id,route_id:source.route_id,fingerprint:routeConfigFingerprint(source)})),bindings:recruitmentCoverage(company,targetMode).map(({source_id,route_ids})=>({source_id,route_ids}))}))).digest('hex');
 const configs=(company.recruitment_sources?.length?company.recruitment_sources:[company]).map(s=>Object.fromEntries(['identity_verification','job_namespace','provider','primary_entry_url','api_config','list_page_size','project_type','route_evidence_url','official_job_url_template','validated_api_request_examples','public_bootstrap_requests'].filter(k=>s[k]!==undefined).map(k=>[k,s[k]])));
 return createHash('sha256').update(JSON.stringify(canonical(collectorRevision?{configs,targetMode,policy:MODE_POLICY_VERSION,collectorRevision}:targetMode==='campus'?configs:{configs,targetMode,policy:MODE_POLICY_VERSION}))).digest('hex');
}
