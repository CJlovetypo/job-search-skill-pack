import {createClient} from './http.mjs';import{normalizeJobLocations,jobCityStatus}from'./locations.mjs';
export async function collectCvte(source,options={}){
 const client=createClient(options),base='https://campus.cvte.com',jobs=new Map(),pages=[],pr=await client.request({url:base+'/api/project'},{purpose:'public_recruitment_projects'});
 if(pr.record.http_status!==200||!Array.isArray(pr.data?.projects))throw Error('Invalid CVTE projects API');
 let reason='All projects returned by public configuration enumerated; API returns whole arrays and official UI paginates locally';
 try{for(const p of pr.data.projects){if(pages.length>=(options.maxPages||Infinity)){reason='project_sample_limit_reached';break;}const r=await client.request({url:base+'/api/position?projectIds='+encodeURIComponent(p.id)},{purpose:'job_list_full_body'});if(r.record.http_status!==200||!Array.isArray(r.data?.projectPositions))throw Error('Invalid CVTE full-list API');
  pages.push({project_id:p.id,project_name:p.name,rows:r.data.projectPositions.length,response_file:r.record.response_file});
  for(const d of r.data.projectPositions){const raw=(d.areaViews||[]).map(x=>x.cityName).filter(Boolean),loc=normalizeJobLocations({locations_raw:raw}),formal=/实习/.test(p.name+' '+d.propertyName)?'internship':/校园招聘|博士生招聘/.test(p.name)&&/全职/.test(d.propertyName)?'formal':'unknown';
   jobs.set(d.id,{company_id:source.company_id,display_name:source.display_name,job_id:d.id,title:d.name,official_url:base+'/position/'+d.id,description:d.duty||'',requirements:d.requirement||'',body_complete:!!(d.duty?.length>15&&d.requirement?.length>15),locations_raw:raw,cities:loc.cities,location_status:(loc.unknown?'unknown':'included'),formal_status:formal,open_status:Date.now()<p.endTime&&Date.now()>=p.startTime?'open':'unknown',recruitment_evidence:{provider:'cvte',project_id:p.id,project_name:p.name,property_name:d.propertyName,startTime:p.startTime,endTime:p.endTime,project_evidence:pr.record.response_file},evidence_files:[r.record.response_file],raw_metadata:{type_name:d.typeName,internship_duration:d.internshipDuration}});
  }
 }}catch(error){reason=error.message;}
 const complete=pages.length===pr.data.projects.length;
 return{company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs:[...jobs.values()],requests:client.records,coverage:{status:complete?'complete':pages.length?'partial':'failed',list_complete:complete,pages:pages.length,page_evidence:pages,jobs_observed:jobs.size,server_total:null,reason}};
}
