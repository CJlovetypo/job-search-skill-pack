import {createClient} from './http.mjs';
import {normalizeJobLocations} from './locations.mjs';
import {collectWorkdayLocationFallback} from './workday-location-fallback.mjs';
import {smartRecruitersOpenStatus,additionalRequirements} from './normalization-additions.mjs';

const clean=s=>String(s||'').replace(/<\/(?:p|div|li|h[1-6])>|<br\s*\/?\s*>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/\n{3,}/g,'\n\n').trim();
const cityFields=job=>{const x=normalizeJobLocations(job);return {cities:x.cities,location_special:x.special,location_unknown:x.unknown,location_unresolved:x.unresolved};};
function combinedBody(html){const all=clean(html);const m=/(?:^|\n)\s*(?:[•\-*]\s*)?(?:任职要求|岗位要求|职位要求|任职资格|招聘要求|基本要求|教育背景|专业技能|Qualifications?(?:\s*\/\s*Requirements?)?|(?:Basic|Minimum|Required|Preferred) Qualifications|Requirements?(?:\s*\/\s*Qualifications)?|Your (?:Profile|Background)|Who you are|What (?:we(?:'|’)re|we are) looking for|What you (?:bring|need)|What (?:you(?:'|’)ll|you will) (?:need|bring)|What we need to see|What qualities and skills are we looking for\??|Skills[\s&]+Qualifications|Position requirements|About the candidate|Education and Experience Requirements)\s*[:：]?/im.exec(all);return {description:all,requirements:m?all.slice(m.index):'',body_complete:!!m&&m.index>35&&all.slice(m.index+m[0].length).trim().length>30};}
function formalType(title,body,types=''){
  if(/实习|\bintern(?:ship)?\b/i.test(title+' '+types))return 'internship';
  // Explicit graduate hiring title plus corroborating graduate/degree eligibility in the body.
  const nonCampusOffer=/可接受应届|接受应届|应届.{0,8}优先|graduates? (?:welcome|preferred)/i;
  if(/校园招聘|校招|应届|new (?:college )?grad|graduate (?:program|engineer|trainee)|\b20\d{2}\b.*graduate/i.test(title)&&!nonCampusOffer.test(title)
    &&/应届|毕业生|届|graduat|bachelor|master|university|学士|硕士|本科/i.test(body))return 'formal';
  if(nonCampusOffer.test(title))return 'unknown';
  const eligibility=body.split(/[\n。；;]/).filter(line=>!nonCampusOffer.test(line)&&!/优先|可接受|放宽|亦可|或者|welcome|prefer|consider|relax/i.test(line)).join('\n');
  if(/full[ -]?time/i.test(types)&&/(?:20\d{2}\s*(?:届|应届毕业生)|(?:须为|需为|招聘对象.{0,6})应届毕业生|graduat(?:ed|ing|ion)\s+(?:in|between|from)\s+20\d{2})/i.test(eligibility))return 'formal';
  return 'unknown';
}
export function normalizeWorkday(raw,source,record){const d=raw.jobPostingInfo||{},parts=combinedBody(d.jobDescription);if(!parts.body_complete)Object.assign(parts,additionalRequirements(parts.description)||{});const loc=[d.location,...(d.additionalLocations||[]).map(x=>typeof x==='string'?x:x.descriptor)].filter(Boolean);return {
  job_id:String(d.jobReqId||d.id||''),company_id:source.company_id,company_name:source.display_name,title:d.title||'',...parts,
  locations_raw:loc,...cityFields({locations_raw:loc,title:d.title,...parts}),official_url:d.externalUrl||null,job_url_kind:d.externalUrl?'official_detail':'unavailable',
  formal_status:formalType(d.title,parts.description,d.workerType||d.timeType),open_status:d.canApply===true?'open':d.canApply===false?'closed':'unknown',
  recruitment_evidence:{provider:'workday',title:d.title,timeType:d.timeType,workerType:d.workerType,country:d.country,canApply:d.canApply,classification_basis:'Explicit graduate title with eligibility, or full-time with explicit fresh-graduate/cohort requirement in JD; ordinary full-time jobs remain unknown.'},raw_file:record.response_file,
  raw_metadata:{hiring_organization:raw.hiringOrganization,country:d.country,location:d.jobRequisitionLocation},
};}
export function normalizeSmartRecruiters(d,source,record,fromPublishedList=false){const s=d.jobAd?.sections||{};let description=clean(s.jobDescription?.text),requirements=clean(s.qualifications?.text),body_complete=description.length>30&&requirements.length>25;if(!description||!requirements){const parts=combinedBody(description||requirements);description=parts.description;requirements=parts.requirements;body_complete=parts.body_complete;}const types=[d.typeOfEmployment?.label,d.experienceLevel?.label].filter(Boolean).join(' '),loc=[d.location?.city,d.location?.region].filter(Boolean);return {
  job_id:String(d.id||''),company_id:source.company_id,company_name:source.display_name,title:d.name||'',description,requirements,body_complete,
  locations_raw:loc,...cityFields({locations_raw:loc,title:d.name,description,requirements}),official_url:d.postingUrl||null,job_url_kind:d.postingUrl?'official_detail':'unavailable',
  formal_status:formalType(d.name,description+'\n'+requirements,types),open_status:smartRecruitersOpenStatus(d,fromPublishedList),
  recruitment_evidence:{provider:'smartrecruiters',typeOfEmployment:d.typeOfEmployment,experienceLevel:d.experienceLevel,customField:d.customField,title:d.name},raw_file:record.response_file,
  raw_metadata:{country:d.location?.country,company:d.company},
};}
const requestJson=async(client,q,purpose)=>{const r=await client.request(q,{purpose});if(r.record.http_status!==200||!r.data)throw Error('Expected public JSON; HTTP '+r.record.http_status);return r;};
/** Match a returned requisition to the observed list, allowing Workday's posting-version suffix. */
export function assertWorkdayDetailIdentity(row,raw) {
  const info=raw.jobPostingInfo||{},id=String(info.jobReqId||info.id||'');
  if(!id)throw Error('Missing Workday detail job ID');
  const bulletIds=(row.bulletFields||[]).map(x=>typeof x==='string'?x.trim():String(x?.descriptor||''));
  if(bulletIds.includes(id))return;
  let tail;try{tail=decodeURIComponent(String(row.externalPath||'').split('/').at(-1));}catch{throw Error('Invalid observed Workday externalPath');}
  const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  // Observed examples include _R_363782-1, _249346W-1 and _R-102607-5.
  if(new RegExp('(?:^|_)'+escaped+'(?:-\\d+)?$').test(tail))return;
  throw Error('Workday detail ID mismatch: '+id+' is not the observed list requisition');
}
export function workdayListPlaceholder(row,source,record,error) {
  const loc=[row.locationsText].filter(Boolean);
  return {job_id:String(row.externalPath),company_id:source.company_id,company_name:source.display_name,title:row.title||'',
    description:'',requirements:'',body_complete:false,locations_raw:loc,...cityFields({locations_raw:loc,title:row.title}),
    official_url:source.api_config.origin+(source.api_config.public_path||'/'+source.api_config.site)+row.externalPath,job_url_kind:'official_detail',
    formal_status:'unknown',open_status:'unknown',raw_file:record.response_file,list_raw_file:record.response_file,
    raw_metadata:{observed_external_path:row.externalPath,observed_bullet_fields:row.bulletFields,detail_fetch_error:error}};
}
// Explicit mainland country descriptors observed in public Workday responses.
// Do not use a China substring match: HK/TW-labelled records remain excluded.
export function isMainlandChinaCountry(value){
  if(typeof value!=='string')return false;
  const country=value.normalize('NFKC').trim().replace(/\s+/g,' ');
  return /^(?:cn|China|China Mainland|Mainland China|China\s*\(\s*Mainland\s*\)|China\s*\/\s*Mainland|中国|中国大陆)$/i.test(country);
}
// A multi-location posting may have a foreign primary location and a mainland requisition location.
export function isWorkdayMainlandDetail(raw){
  const d=raw?.jobPostingInfo||{};
  return isMainlandChinaCountry(d.country?.descriptor)||isMainlandChinaCountry(d.jobRequisitionLocation?.country?.descriptor);
}
function chinaFacet(facets){let answer=null;const walk=f=>{if(!f||typeof f!=='object')return;if(f.facetParameter&&Array.isArray(f.values)){const x=f.values.find(x=>isMainlandChinaCountry(x.descriptor));if(x)answer={field:f.facetParameter,value:x.id,label:x.descriptor};}for(const x of Object.values(f))if(x&&typeof x==='object')Array.isArray(x)?x.forEach(walk):walk(x);};walk(facets);return answer;}
export async function collectInternational(source,options={}){
  if(!['workday','smartrecruiters'].includes(source.provider))return null;
  const opts={maxPages:1000,pageSize:source.provider==='workday'?20:100,detailConcurrency:3,timeoutMs:20000,...options};
  const client=options.client||createClient(opts),jobs=[],rows=new Map(),pages=[],errors=[],excluded=[];let total=null,complete=false,reason='max_pages_reached',filter=null,detailsFailed=0;
  const cfg=source.api_config||{};let listURL,body;
  try{
    if(source.provider==='workday'){
      listURL=cfg.origin+'/wday/cxs/'+cfg.tenant+'/'+cfg.site+'/jobs';
      const boot=await requestJson(client,{url:listURL,method:'POST',body:{appliedFacets:{},limit:20,offset:0,searchText:''}},'public_country_facet_discovery');
      filter=chinaFacet(boot.data.facets);if(!filter)return collectWorkdayLocationFallback(source,{...opts,client,bootstrap:boot});
      body={appliedFacets:{[filter.field]:[filter.value]},limit:20,offset:0,searchText:opts.keyword||''};
    }else listURL='https://api.smartrecruiters.com/v1/companies/'+encodeURIComponent(cfg.company_identifier)+'/postings';
    let offset=0,initialTotal=null;
    for(let page=0;page<opts.maxPages;page++){
      const u=new URL(listURL);if(source.provider==='smartrecruiters'){u.searchParams.set('country','cn');u.searchParams.set('limit',String(opts.pageSize));u.searchParams.set('offset',String(offset));}
      const r=await requestJson(client,{url:u.href,method:source.provider==='workday'?'POST':'GET',body:source.provider==='workday'?{...body,offset}:null},'job_list');
      const a=source.provider==='workday'?r.data.jobPostings:r.data.content;total=Number(source.provider==='workday'?r.data.total:r.data.totalFound);
      if(!Array.isArray(a)||!Number.isFinite(total))throw Error('Missing expected jobs/count fields');
      const reportedTotal=total;
      // Workday can omit the count on noninitial pages by returning zero with rows.
      // Keep the first count; still require unique IDs to reconcile it exactly.
      if(source.provider==='workday'&&offset>0&&total===0&&a.length&&initialTotal>0)total=initialTotal;
      if(initialTotal===null)initialTotal=total;else if(total!==initialTotal)errors.push('server_total_changed');
      const ids=a.map(j=>String(j.externalPath||j.id||'')),before=rows.size;
      if(ids.some(id=>rows.has(id))||new Set(ids).size!==ids.length)errors.push('duplicate_job_ids_across_pages');
      for(const j of a)if(j.externalPath||j.id)rows.set(String(j.externalPath||j.id),{row:j,record:r.record});
      pages.push({page:page+1,job_ids:ids,response_file:r.record.response_file,server_total:total,reported_server_total:reportedTotal,new_ids:rows.size-before});
      if(ids.some(x=>!x)){reason='missing_job_id';break;}
      if(rows.size===total){complete=!errors.length;reason='unique_ids_reconcile_server_total';break;}
      if(!a.length||rows.size===before){reason='empty_or_repeated_page_before_total';break;}
      offset+=a.length;
    }
  }catch(e){reason=e.message;errors.push(e.message);}
    // Detail processing is outside the pagination try: a failed later page keeps earlier rows.
    const eligible=[...rows.values()].filter(({row})=>!opts.titleFilter||opts.titleFilter(row.title||row.name));
    const queue=opts.maxDetails==null?eligible:eligible.slice(0,Math.max(0,opts.maxDetails));let cursor=0;
    for(const {row,record} of eligible.slice(queue.length))jobs.push(source.provider==='workday'?workdayListPlaceholder(row,source,record,'detail_limit'): {...normalizeSmartRecruiters(row,source,record,true),body_complete:false,detail_skipped_reason:'detail_limit'});
    await Promise.all(Array.from({length:opts.detailConcurrency},async()=>{while(cursor<queue.length){const {row,record}=queue[cursor++];try{
      const url=source.provider==='workday'?cfg.origin+'/wday/cxs/'+cfg.tenant+'/'+cfg.site+row.externalPath:row.ref;
      if(source.provider==='workday'&&!String(row.externalPath).startsWith('/job/'))throw Error('Unexpected externalPath');
      if(source.provider==='smartrecruiters'&&!String(url).startsWith(listURL+'/'))throw Error('Unexpected detail API reference');
      const r=await requestJson(client,{url},'job_detail');
      if(source.provider==='workday')assertWorkdayDetailIdentity(row,r.data);
      const country=source.provider==='workday'?r.data.jobPostingInfo?.country?.descriptor:r.data.location?.country;
      if(!(source.provider==='workday'?isWorkdayMainlandDetail(r.data):isMainlandChinaCountry(country))){errors.push('Country filter not confirmed in detail '+(row.id||row.externalPath));excluded.push({job_id:row.id||row.externalPath,country,raw_file:r.record.response_file});continue;}
      const j=source.provider==='workday'?normalizeWorkday(r.data,source,r.record):normalizeSmartRecruiters(r.data,source,r.record,true);
      if(!j.job_id)throw Error('Missing detail job ID');
      if(source.provider==='smartrecruiters'&&j.job_id!==String(row.id))throw Error('Detail ID mismatch');
      j.list_raw_file=record.response_file;jobs.push(j);
    }catch(e){errors.push(e.message);detailsFailed++;
      if(source.provider==='workday')jobs.push(workdayListPlaceholder(row,source,record,e.message));
      else {const j=normalizeSmartRecruiters(row,source,record,true);jobs.push({...j,description:'',requirements:'',body_complete:false,list_raw_file:record.response_file,raw_metadata:{...j.raw_metadata,detail_fetch_error:e.message}});}
    }}}));
  const incomplete=jobs.filter(j=>!j.body_complete).length;if(incomplete)errors.push(incomplete+' jobs have unresolved JD sections');
  const status=complete&&!errors.length?'complete':jobs.length||pages.length?'partial':'failed';
  return {company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs,requests:client.records,coverage:{status,pages:pages.length,server_total:total,jobs_observed:jobs.length,list_complete:complete,reason:[reason,...errors].join('; '),page_evidence:pages,country_filter:filter||{country:'cn'},scope:'Mainland China positions in this public portal',details_failed:detailsFailed,excluded_country_rows:excluded,incomplete_bodies:incomplete}};
}
