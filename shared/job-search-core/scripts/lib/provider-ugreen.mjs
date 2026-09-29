import fs from'node:fs/promises';import path from'node:path';import{createHash,randomBytes}from'node:crypto';import{createClient}from'./http.mjs';
import {maintenanceNetworkScope} from './maintenance-network-scope.mjs';
const plain=s=>String(s||'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/<\/(?:p|div)>|<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').trim();
export async function collectUgreen(source,options={}){
 const client=createClient(options),dir=path.resolve(options.evidenceDir),origin='https://hrh5.ugreensmart.com',base='https://www.ugreensmart.com/backend/hr-extranet/API/RecruitmentManage/',jobs=[],pages=[];
 const h=await client.request({url:origin+'/UgreenWeiXin/campus'},{purpose:'public_signature_bootstrap'}),js=new URL(h.text.match(/<script[^>]+src="([^"]+\.js)"/)[1],h.url).href,s=await client.request({url:js},{purpose:'public_signature_configuration'});
 const secret=s.text.match(/&&appSecret=([^`"']+)/)?.[1];if(!secret)throw Error('Public JS signature configuration unavailable');
 for(const type of ['校招','社招']){const timestamp=Math.floor(Date.now()/1000),nonce=randomBytes(16).toString('hex'),sig=createHash('sha256').update(`timestamp=${timestamp}&nonce=${nonce}&&appSecret=${secret}`).digest('hex');
  const url=base+'GetRecruitmentCategoryJobInfoWithout',body={RecruitmentMethod:type,recruitmentCategoryID:'',title:''},scope=maintenanceNetworkScope(),purpose='public_job_list_full_body';
  scope?.claim(purpose);
  if(options.requestBudget&&--options.requestBudget.remaining<0)throw Error('public_request_budget_exhausted');
  const signal=AbortSignal.any([AbortSignal.timeout(options.timeoutMs||25000),options.signal,scope?.signal].filter(Boolean));signal.throwIfAborted();
  const record={url,method:'POST',body,purpose,anonymous_session_from_scratch:true,signature_basis:'Computed from current public website JS, timestamp and random nonce; no personal credentials; signature and Authorization not persisted',public_config_response:s.record.response_file,checked_at:new Date().toISOString()};client.records.push(record);scope?.records.push(record);
  let response,raw;const release=scope?await scope.limiter.acquire(url,signal):()=>{};
  try{
    if(scope&&--scope.remaining<0)throw Error('maintenance_request_budget_exhausted');
    response=await fetch(url,{method:'POST',headers:{Authorization:`${sig} ${timestamp} ${nonce}`,Referer:h.url,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'manual',signal});
    if(scope&&response.status===429)scope.limiter.rateLimit(url,response.headers.get('retry-after'));
    raw=await response.text();
  }catch(error){record.error=error.message;throw error;}finally{release();}
  const file=path.join(dir,'ugreen-'+type+'.json');await fs.writeFile(file,raw);
  Object.assign(record,{http_status:response.status,content_type:response.headers.get('content-type'),response_file:file,response_is_json:true,response_sha256:createHash('sha256').update(raw).digest('hex')});
  const data=JSON.parse(raw);if(response.status!==200||data.staus!=='success'||!Array.isArray(data.data))throw Error('Ugreen public list failed');pages.push({type,rows:data.data.length,response_file:file});
  for(const d of data.data){const description=plain(d.description),match=description.match(/任职资格|任职要求|岗位要求|职位要求/),requirements=match?description.slice(match.index):'';jobs.push({company_id:source.company_id,display_name:source.display_name,job_id:String(d.ID),title:d.title,official_url:origin+'/UgreenWeiXin/'+(type==='校招'?'campus':'resume')+'/job/'+d.ID,description,requirements,body_complete:description.length>35&&requirements.length>20,locations_raw:[],cities:[],location_status:'unknown',formal_status:/实习/.test(d.title)?'internship':type==='社招'?'social':'unknown',open_status:d.IsShelf===true?'open':'unknown',recruitment_evidence:{provider:'ugreen',RecruitmentMethod:d.RecruitmentMethod,IsShelf:d.IsShelf,category:d.CategoryName},raw_file:file,evidence_files:[file],raw_metadata:{education:d.min_education,working_life:d.working_life}});}
 }
 return{company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs,requests:client.records,coverage:{status:'complete',list_complete:true,pages:pages.length,page_evidence:pages,jobs_observed:jobs.length,server_total:null,reason:'Official public campus/social API returns whole arrays; official UI uses local pagination; cities absent in API remain unknown'}};
}
