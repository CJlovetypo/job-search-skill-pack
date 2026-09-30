import {createClient} from './http.mjs';
import {normalizeJobLocations} from './locations.mjs';
import {reviewRecruitment} from './recruitment-policy.mjs';

function decode(value) {
  return String(value??'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)))
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"')
    .replace(/&apos;/g,"'").replace(/&nbsp;/g,' ').replace(/&amp;/g,'&');
}
export function plainJobText(value) {
  return decode(value).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'')
    .replace(/<(?:br\s*\/?|\/p|\/div|\/li|\/h[1-6])>/gi,'\n').replace(/<[^>]*>/g,'')
    .replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n\n').trim();
}
function fullBody(html) {
  const description=plainJobText(html);
  const marker=description.match(/Qualifications|Requirements|What you bring|Who you are|What you bring to the team|What you['’]ll bring|任职要求|职位要求|任职资格/i);
  const requirements=marker?description.slice(marker.index):'';
  return {description,requirements,body_complete:description.length>100&&requirements.length>40};
}
function withCities(job) {
  const loc=normalizeJobLocations(job);
  return {...job,cities:loc.cities,location_special:loc.special,location_unknown:loc.unknown,location_unresolved:loc.unresolved};
}
export function normalizeMicrosoftJob(row,source,rawFile) {
  const type=(row.efcustomTextEmploymentType||[]).join(', '),body=fullBody(row.jobDescription);
  let formal='unknown';
  if(/intern/i.test(type)||/\bintern(?:ship)?\b/i.test(row.name||''))formal='internship';
  else if(/full.?time/i.test(type)&&/(?:20\d{2}\s*届|(?:graduat(?:e|ed|ing|ion)\s+(?:in|between|from)\s+20\d{2})|new graduates?|recent graduates?|university graduates?)/i.test(body.description))formal='formal';
  const publicUrl=new URL(row.positionUrl||'/careers/job/'+row.id,new URL(source.primary_entry_url).origin).href;
  return withCities({job_id:String(row.id),company_id:source.company_id,company_name:source.display_name,title:row.name||'',
    locations_raw:row.locations||[],...body,formal_status:formal,open_status:row.id&&row.jobDescription?'open':'unknown',
    recruitment_evidence:{provider:'microsoft_eightfold',employment_type:row.efcustomTextEmploymentType||[],published_search_and_detail:true,formal_basis:formal==='formal'?'Full-time API field and explicit graduate/cohort requirement in the full JD':null},
    official_url:publicUrl,job_url_kind:'official_detail',raw_file:rawFile,
    raw_metadata:{ats_job_id:row.atsJobId,department:row.department,posted_ts:row.postedTs,work_site:row.efcustomTextWorkSite,query_scope:'China, using the current public search location parameter'}});
}
function payload(response) {
  if(response.record.http_status!==200||!response.data||Number(response.data.status)!==200)throw new Error('Microsoft public API HTTP '+response.record.http_status+' / status '+response.data?.status);
  return response.data.data;
}
export async function collectMicrosoft(source,options={}) {
  const client=createClient(options),jobs=new Map(),pages=[],errors=[];
  const headers={Accept:'application/json',Referer:source.primary_entry_url,Origin:new URL(source.primary_entry_url).origin,'X-Requested-With':'XMLHttpRequest'};
  let total=null,initialTotal=null,offset=0,listComplete=false,reason='max_pages_reached';
  try {
    const boot=await client.request({url:source.primary_entry_url},{purpose:'public_anonymous_bootstrap'});
    if(boot.record.http_status!==200)throw Error('Microsoft public bootstrap HTTP '+boot.record.http_status);
    const listTemplate=source.validated_api_request_examples.find(q=>new URL(q.url).pathname==='/api/pcsx/search');
    const detailTemplate=source.validated_api_request_examples.find(q=>new URL(q.url).pathname==='/api/pcsx/position_details');
    if(!listTemplate||!detailTemplate)throw Error('Verified Microsoft search/detail configuration missing');
    for(let page=0;page<(options.maxPages||1000);page++) {
      const url=new URL(listTemplate.url);url.searchParams.set('start',String(offset));
      const response=await client.request({url:url.href,headers},{purpose:'job_list'}),data=payload(response);
      if(!Array.isArray(data.positions)||!Number.isInteger(data.count))throw Error('Microsoft positions/count missing');
      total=data.count;if(initialTotal===null)initialTotal=total;else if(initialTotal!==total)errors.push('server_total_changed');
      const ids=data.positions.map(p=>String(p.id)),fresh=data.positions.filter(p=>!jobs.has(String(p.id)));
      pages.push({page:page+1,offset,server_total:total,job_ids:ids,new_ids:fresh.length,response_file:response.record.response_file});
      let cursor=0;
      await Promise.all(Array.from({length:Math.min(3,fresh.length)},async()=>{
        while(cursor<fresh.length){const row=fresh[cursor++];
          try {const detailUrl=new URL(detailTemplate.url);detailUrl.searchParams.set('position_id',String(row.id));
            const detail=await client.request({url:detailUrl.href,headers},{purpose:'job_detail'}),record=payload(detail);
            if(String(record.id)!==String(row.id))throw Error('Detail ID mismatch');
            const job=normalizeMicrosoftJob(record,source,detail.record.response_file);jobs.set(job.job_id,job);
            if(!job.body_complete)errors.push('missing_body:'+job.job_id);
          }catch(e){errors.push('detail:'+row.id+':'+e.message);jobs.set(String(row.id),normalizeMicrosoftJob(row,source,response.record.response_file));}
        }
      }));
      offset+=data.positions.length;
      if(jobs.size===total){listComplete=true;reason='unique_ids_reconcile_server_total';break;}
      if(!data.positions.length||!fresh.length){reason='empty_or_repeated_page_before_total';break;}
    }
  }catch(e){errors.push(e.message);reason=e.message;}
  const status=listComplete&&!errors.length?'complete':pages.length?'partial':'failed';
  return {company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs:[...jobs.values()],requests:client.records,
    coverage:{status,pages:pages.length,server_total:total,jobs_observed:jobs.size,list_complete:listComplete,reason,errors,page_evidence:pages,scope:'Current Microsoft public careers search for China; not every global or research-only portal'}};
}
export function normalizeSapFeed(xml,source,rawFile) {
  if(!/<rss\b/.test(xml)||!/<channel>/.test(xml))throw Error('SAP RSS response missing channel');
  const configuredOrigins=new Set([source.primary_entry_url,...(source.validated_api_request_examples||[]).map(q=>q.url)].filter(Boolean).map(url=>new URL(url).origin));
  const jobs=[];
  for(const item of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)){
    const field=name=>decode(item[1].match(new RegExp('<'+name+'>([\\s\\S]*?)</'+name+'>'))?.[1]||'');
    const title=field('title'),link=field('link'),html=field('description'),body=fullBody(html),id=link.match(/\/(\d+)\/?(?:\?|$)/)?.[1];
    let official;try{official=new URL(link);}catch{}
    if(!id||!official||!['https://jobs.sap.com','https://careers.sap.com'].includes(official.origin)||!configuredOrigins.has(official.origin)||official.username||official.password||!official.pathname.startsWith('/job/'))throw Error('SAP item missing official stable job ID');
    const employment=body.description.match(/Employment Type:\s*([^|\n]+)/i)?.[1]?.trim()||null;
    const career=body.description.match(/Career Status:\s*([^|\n]+)/i)?.[1]?.trim()||null;
    let formal='unknown';
    if(/\bintern(?:ship|s)?\b/i.test(title)||/^Student$/i.test(career||''))formal='internship';
    else if(/^Graduate$/i.test(career||'')&&/Regular Full Time/i.test(employment||''))formal='formal';
    else if(/Professional|Management|Executive/i.test(career||''))formal='social';
    const city=title.match(/\(([^()]*(?:, CN|China)[^()]*)\)\s*$/)?.[1];
    jobs.push(withCities({job_id:id,company_id:source.company_id,company_name:source.display_name,title,
      locations_raw:city?[city]:[],...body,formal_status:formal,open_status:'unknown',
      recruitment_evidence:{provider:'sap_rss',career_status:career,employment_type:employment,published_feed:true,open_status_note:'RSS is a latest-items feed, not a live per-job active-status API'},
      official_url:link,job_url_kind:'official_detail',raw_file:rawFile,raw_metadata:{published_at:field('pubDate'),feed_scope:'China latest 10 items'}}));
  }
  return jobs;
}
export async function collectSap(source,options={}) {
  const client=createClient(options);let jobs=[],reason='latest_10_feed_without_pagination_contract';
  try {const q=source.validated_api_request_examples[0],response=await client.request({...q,headers:{Accept:'application/rss+xml,application/xml,text/xml',...q.headers}},{purpose:'public_job_feed'});
    if(response.record.http_status!==200)throw Error('SAP RSS HTTP '+response.record.http_status);
    jobs=normalizeSapFeed(response.text,source,response.record.response_file);
    return {company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs,requests:client.records,
      coverage:{status:'partial',pages:1,server_total:null,jobs_observed:jobs.length,list_complete:false,reason,scope:'Official SAP China RSS, latest 10 items; no confirmed pagination or live vacancy status'}};
  }catch(e){return {company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs,requests:client.records,coverage:{status:'failed',pages:0,server_total:null,jobs_observed:0,reason:e.message}};}
}

export function normalizeAmazonJob(row,source,rawFile) {
  const description=plainJobText(row.description),basic=plainJobText(row.basic_qualifications),preferred=plainJobText(row.preferred_qualifications);
  const requirements=[basic,preferred?'Preferred qualifications:\n'+preferred:''].filter(Boolean).join('\n\n');
  const yes=v=>v===true||v===1||v==='1'||v==='true';
  let formal='unknown';
  if(yes(row.is_intern)||/\bintern(?:ship)?\b|实习生|实习岗/i.test(row.title||''))formal='internship';
  else if(row.job_schedule_type==='full-time'&&(yes(row.university_job)||(/\bcampus\b|校招|校园招聘/i.test(row.title||'')&&/应届|20\d{2}.*(?:graduat|毕业)|graduat.{0,30}20\d{2}/i.test(description))))formal='formal';
  const official=new URL(row.job_path,source.primary_entry_url);
  if(official.hostname!=='www.amazon.jobs'||!/^\/\w+\/jobs\/[A-Za-z0-9]+\//.test(official.pathname))throw Error('Amazon official job path missing');
  return withCities(reviewRecruitment({job_id:official.pathname.match(/\/jobs\/([A-Za-z0-9]+)\//)[1],company_id:source.company_id,company_name:source.display_name,title:row.title,
    description,requirements,body_complete:description.length>50&&basic.length>0,locations_raw:row.locations?.length?row.locations:[row.location].filter(Boolean),
    formal_status:formal,open_status:'open',official_url:official.href,job_url_kind:'official_detail',raw_file:rawFile,
    recruitment_evidence:{provider:'amazon_jobs',university_job:row.university_job,is_intern:row.is_intern,primary_search_label:row.primary_search_label,job_schedule_type:row.job_schedule_type,published_public_search:true,formal_basis:formal==='formal'?'Full-time API field plus university_job or campus title corroborated by explicit cohort/graduate body requirement':null},
    raw_metadata:{posted_date:row.posted_date,updated_time:row.updated_time,business_category:row.business_category,country_code:row.country_code,source_job_uuid:row.id}}));
}

export async function collectAmazon(source,options={}) {
  const client=createClient(options),jobs=new Map(),pages=[],errors=[];
  let total=null,offset=0,complete=false,reason='max_pages_reached';
  try {
    const template=source.validated_api_request_examples[0];
    for(let page=0;page<(options.maxPages||1000);page++){
      const url=new URL(template.url);url.searchParams.set('offset',String(offset));
      const response=await client.request({url:url.href},{purpose:'job_list_and_full_jd'}),data=response.data;
      if(response.record.http_status!==200||data?.error||!Array.isArray(data?.jobs)||!Number.isInteger(data.hits))throw Error('Amazon search did not return a valid jobs/hits response');
      if(total!==null&&total!==data.hits)errors.push('server_total_changed');total=data.hits;
      const before=jobs.size,ids=[];
      for(const row of data.jobs){
        if(row.country_code!=='CHN')throw Error('Amazon country filter was not honored');
        const job=normalizeAmazonJob(row,source,response.record.response_file);ids.push(job.job_id);jobs.set(job.job_id,job);
        if(!job.body_complete)errors.push('missing_body:'+job.job_id);
      }
      const fresh=jobs.size-before;pages.push({page:page+1,offset,server_total:total,new_ids:fresh,job_ids:ids,response_file:response.record.response_file});
      offset+=data.jobs.length;
      if(jobs.size===total){complete=true;reason='unique_ids_reconcile_server_total';break;}
      if(!data.jobs.length||!fresh){reason='empty_or_repeated_page_before_total';break;}
    }
  }catch(e){errors.push(e.message);reason=e.message;}
  return {company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs:[...jobs.values()],requests:client.records,
    coverage:{status:complete&&!errors.length?'complete':pages.length||jobs.size?'partial':'failed',pages:pages.length,server_total:total,jobs_observed:jobs.size,list_complete:complete,reason,errors,page_evidence:pages,scope:'Amazon public search country=CHN; mainland China only'}};
}
