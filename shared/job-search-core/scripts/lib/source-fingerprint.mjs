import {createHash} from 'node:crypto';
import {SEARCH_MODE,MODE_POLICY_VERSION} from './search-mode.mjs';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export function sourceConfigFingerprint(company,targetMode=SEARCH_MODE.id){
 const configs=(company.recruitment_sources?.length?company.recruitment_sources:[company]).map(s=>Object.fromEntries(['identity_verification','job_namespace','provider','primary_entry_url','api_config','list_page_size','project_type','route_evidence_url','official_job_url_template','validated_api_request_examples','public_bootstrap_requests'].filter(k=>s[k]!==undefined).map(k=>[k,s[k]])));
 return createHash('sha256').update(JSON.stringify(canonical(targetMode==='campus'?configs:{configs,targetMode,policy:MODE_POLICY_VERSION}))).digest('hex');
}
