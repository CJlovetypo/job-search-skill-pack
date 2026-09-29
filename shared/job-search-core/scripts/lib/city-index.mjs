import {isTargetJob} from './search-mode.mjs';
const coverageSummary=c=>Object.fromEntries(['status','pages','server_total','jobs_observed','reason','collection_complete','details_failed','incomplete_bodies','scope','direction_sources'].filter(k=>c?.[k]!==undefined).map(k=>[k,c[k]]));
export function compactCityTag(tag){
 const evidence=tag.city_evidence||[],counts=new Map(),sample=[];
 for(const e of evidence){const cities=(e.cities||[]).filter(c=>(counts.get(c)||0)<2);if(!cities.length)continue;for(const c of cities)counts.set(c,(counts.get(c)||0)+1);sample.push(e);}
 return {...tag,coverage:{...coverageSummary(tag.coverage),...tag.coverage?.contexts?{contexts:tag.coverage.contexts.map(c=>({source_id:c.source_id,route_id:c.route_id,provider:c.provider,...coverageSummary(c)}))}:{}},city_evidence:sample,city_evidence_total:tag.city_evidence_total??evidence.length,city_evidence_scope:'up_to_two_examples_per_city; complete_observations_in_result_file'};
}

export function refreshedCityTag(source,result,previous,{mode,fingerprint,resultFile}={}){
 const observed=(result.jobs||[]).filter(j=>isTargetJob(j,mode)&&j.open_status==='open');
 const cities=[...new Set(observed.flatMap(j=>j.cities||[]))].sort();
 const unknown=observed.filter(j=>j.location_unknown||(j.location_special||[]).length);
 const uncertain=(result.jobs||[]).filter(j=>j.formal_status==='unknown'||j.open_status==='unknown');
 const at=result.checked_at||new Date().toISOString(),coverage=result.coverage||{status:'failed'};
 const directionConfirmed=!coverage.direction_sources||coverage.direction_sources.every(s=>s.status==='declared'&&!s.limitation);
 const complete=coverage.status==='complete'&&directionConfirmed&&!unknown.length&&!uncertain.length;
 const base={company_id:source.company_id,display_name:source.display_name,cities,updated_at:at,coverage,search_mode:mode,source_config_fingerprint:fingerprint,formal_jobs_observed:observed.length,target_jobs_observed:observed.length,unknown_location_jobs:unknown.length,uncertain_type_or_status_jobs:uncertain.length,city_coverage_complete:complete,last_refresh_at:at,last_refresh_status:coverage.status,last_refresh_reason:coverage.reason||null,result_file:resultFile,
  city_evidence:observed.filter(j=>j.cities?.length).map(j=>({job_id:j.job_id,title:j.title,cities:j.cities,locations_raw:j.locations_raw,official_url:j.official_url,raw_file:j.raw_file}))};
 if(coverage.status==='failed')return compactCityTag({...previous,...base,cities:previous?.cities||[],updated_at:previous?.updated_at||null,city_evidence:previous?.city_evidence||[],retained_previous_cities:previous?.cities||[],city_coverage_complete:false,city_freshness:previous?.cities?.length?'stale_retained':'unknown'});
 if(!complete&&previous?.cities?.length){const retained=previous.cities.filter(c=>!cities.includes(c));return compactCityTag({...base,cities:[...new Set([...cities,...previous.cities])].sort(),retained_previous_cities:retained,previous_observation_at:previous.updated_at||null,city_freshness:'partial_with_history'});}
 return compactCityTag({...base,retained_previous_cities:[],city_freshness:complete?'fresh_complete':'partial'});
}
