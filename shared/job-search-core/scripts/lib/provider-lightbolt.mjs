import {createClient} from './http.mjs';
import {normalizeJobLocations,jobCityStatus} from './locations.mjs';
import {reviewProviderBody as reviewJobBody,bodyText} from './body-review.mjs';
import {reviewRecruitment} from './recruitment-policy.mjs';
import {SEARCH_MODE,knownOtherType} from './search-mode.mjs';

/** LightBolt public read APIs discovered in Beisen's published mobile frontend. */
export function normalizeLightboltJob({source,row,detail={},rawFile,listFile,checkedAt,category,ids={}}) {
  const id=String(row.JobAdId),origin=new URL(source.primary_entry_url).origin;
  const kind=Number(detail.Kind??row.KindId),cat=Number(row.CategoryId);
  const end=String(row.ToEndDate||'');
  const expired=/^\d{4}-\d{2}-\d{2}$/.test(end)&&Date.parse(end+'T23:59:59+08:00')<Date.parse(checkedAt);
  let job={company_id:source.company_id,company_name:source.display_name,provider:'beisen_lightbolt',job_id:id,
    title:detail.JobAdName||row.JobAdName,description:bodyText(detail.DutyStr||row.Duty),requirements:bodyText(detail.RequireStr||row.Require),
    locations_raw:[detail.LocName||row.LocIdName].filter(Boolean),official_url:origin+'/JobAd/Info?adid='+id,
    jd_url:origin+'/JobAd/Info?adid='+id,api_url:origin+'/LightBoltAPI/JobAd/Info?adid='+id,
    raw_file:rawFile,list_raw_file:listFile,checked_at:checkedAt,body_complete:false,
    formal_status:/实习|intern/i.test(detail.KindLabel||row.KindName||'')||cat===3?'internship':cat===2&&kind===1?'formal':cat===1?'social':'unknown',
    open_status:expired?'closed':'open',recruitment_evidence:{provider:'beisen_lightbolt',CategoryId:row.CategoryId,
      CategoryName:row.CategoryName,Kind:kind,KindLabel:detail.KindLabel||row.KindName,
      YearsofWorkingLabel:detail.YearsofWorkingLabel||row.YearsofWorkingStr,
      public_list_returned:true,query_jc:category,end_date:end||null,
      source_fields:'API list CategoryId plus detail Kind; no inference from company/portal name'},
    raw_metadata:{TenantId:detail.TenantId||row.TenantId||ids.TenantId,PortalId:detail.PortalId||ids.PortalId,
      CompanyTitle:detail.CompanyTitle,CompanySummary:bodyText(detail.CompanySummary),org:row.OrgName||detail.Department}};
  job=reviewRecruitment(reviewJobBody(job));
  const loc=normalizeJobLocations(job);
  return {...job,cities:loc.cities,location_unknown:loc.unknown,location_unresolved:loc.unresolved,
    location_special:loc.special,location_evidence:loc.structured_evidence};
}

export async function collectLightbolt(source,options={}) {
  const cfg={mode:'list',maxPages:1000,pageSize:20,timeoutMs:20000,detailConcurrency:3,capabilityOnly:false,...options};
  cfg.cityFilters=options.cityFilters??options.cities??[];
  if(!['list','full'].includes(cfg.mode))throw Error('mode must be list or full');
  for(const key of ['maxPages','pageSize','detailConcurrency'])if(!Number.isInteger(cfg[key])||cfg[key]<1)throw Error(key+' must be a positive integer');
  const categories=[...new Set((cfg.categories||source.api_config?.categories||[2]).map(Number))];
  if(!categories.length||categories.some(x=>![1,2,3].includes(x)))throw Error('LightBolt categories must contain only documented values 1, 2 or 3');
  const client=cfg.client||createClient(cfg),origin=new URL(source.primary_entry_url).origin;
  const contexts=[],jobs=new Map(),checkedAt=new Date().toISOString(),bootstrapErrors=[],ids={};
  try {
    const boot=await client.request({url:source.primary_entry_url},{purpose:'public_configuration_bootstrap'});
    if(boot.record.http_status!==200)bootstrapErrors.push('Bootstrap HTTP '+boot.record.http_status);
    ids.TenantId=boot.text.match(/BSGlobal\.TenantId\s*=\s*(\d+)/)?.[1];
    ids.PortalId=boot.text.match(/BSGlobal\.PortalId\s*=\s*(\d+)/)?.[1];
  }catch(error){bootstrapErrors.push(error.message);}
  // A campaign landing may expire independently. Capability still requires fresh JSON below.
  const json=async (url,purpose)=>{
    const r=await client.request({url,headers:{Referer:source.primary_entry_url,'X-Requested-With':'XMLHttpRequest'}},{purpose});
    if(r.record.http_status!==200||!r.data||Number(r.data.Code)!==200)throw Error('LightBolt HTTP '+r.record.http_status+' code '+r.data?.Code+' '+(r.data?.Message||''));
    return r;
  };
  for(const category of categories) {
    const pages=[],stored=new Map(),errors=[];let total=null,listComplete=false,reason='max_pages_reached';
    for(let page=1;page<=cfg.maxPages;page++) {
      const u=new URL('/LightBoltAPI/JobAd/SearchJobAd',origin);
      u.search=new URLSearchParams({...source.api_config?.filters,jc:String(category),pi:String(page),ps:String(cfg.pageSize)}).toString();
      let r;try{r=await json(u.href,'job_list');}catch(error){errors.push(error.message);reason='list_request_failed';break;}
      const p=r.data?.Data?.data;
      if(!p||!Array.isArray(p.DataResult)){errors.push('Missing Data.data.DataResult');reason='invalid_list_shape';break;}
      const count=p.RowCount;
      const pageTotal=count!==null&&count!==undefined&&Number.isFinite(Number(count))?Number(count):null;
      if(total!==null&&pageTotal!==null&&pageTotal!==total)errors.push('server_total_changed_from_'+total+'_to_'+pageTotal);
      total=pageTotal;
      pages.push({request_url:u.href,raw_file:r.record.response_file,page,count:p.DataResult.length,server_total:total});
      const before=stored.size;
      let duplicates=0;
      for(const row of p.DataResult) {
        if(row.JobAdId===undefined||row.JobAdId===null){errors.push('Public list row missing JobAdId');continue;}
        if(stored.has(String(row.JobAdId)))duplicates++;
        stored.set(String(row.JobAdId),{row,listFile:r.record.response_file});
      }
      if(duplicates)errors.push('page_'+page+'_duplicate_job_ids_'+duplicates);
      if(total!==null&&stored.size===total){listComplete=true;reason='unique_ids_reconcile_server_total';break;}
      if(!p.DataResult.length){listComplete=total===null;reason=listComplete?'empty_terminal_page':'empty_page_before_server_total';break;}
      if(stored.size===before){reason='repeated_page_without_new_ids';break;}
      if(total!==null&&stored.size>total){reason='unique_ids_exceed_server_total';break;}
    }
    listComplete=listComplete&&!errors.length;
    let cursor=0,detailsFailed=0,detailsSkipped=0,detailsIncomplete=0;
    const items=[...stored.values()];
    await Promise.all(Array.from({length:cfg.detailConcurrency},async()=>{
      while(cursor<items.length) {
        const {row,listFile}=items[cursor++],id=String(row.JobAdId);
        const args={source,row,listFile,rawFile:listFile,checkedAt,category,ids};
        let job=normalizeLightboltJob(args);
        const existing=jobs.get(id);
        if((cfg.targetMode||SEARCH_MODE.id)!=='campus'&&knownOtherType(job,cfg.targetMode||SEARCH_MODE.id))job.detail_skipped_reason='explicit_non_target_type';
        if(cfg.mode==='full'&&!job.detail_skipped_reason&&(!existing||!existing.body_complete)) {
          if(cfg.cityFilters?.length&&jobCityStatus(job,cfg.cityFilters)==='excluded') {
            detailsSkipped++;job.detail_skipped_reason='explicit_non_target_city';
          }else {
            try {
              const r=await json(origin+'/LightBoltAPI/JobAd/Info?adid='+encodeURIComponent(id),'job_detail');
              const detail=r.data.Data;
              if(String(detail?.JobAdId)!==id)throw Error('Detail ID does not match requested public list ID');
              job=normalizeLightboltJob({...args,detail,rawFile:r.record.response_file});
            }catch(error){detailsFailed++;job.detail_error=error.message;errors.push(id+': '+error.message);}
          }
        }
        if(cfg.mode==='full'&&!job.detail_skipped_reason&&!job.body_complete&&!existing?.body_complete)detailsIncomplete++;
        if(!existing||!existing.body_complete&&job.body_complete)jobs.set(id,job);
      }
    }));
    if(detailsIncomplete)errors.push(detailsIncomplete+' public job bodies incomplete after detail retrieval');
    contexts.push({category,pages:pages.length,server_total:total,jobs_observed:stored.size,list_complete:listComplete,
      status:listComplete&&!errors.length?'complete':pages.length?'partial':'failed',
      reason:errors.length?reason+'; '+errors.join('; '):reason,details_failed:detailsFailed,details_incomplete:detailsIncomplete,details_skipped_city:detailsSkipped,page_evidence:pages});
    if(cfg.capabilityOnly&&[...jobs.values()].some(j=>j.body_complete))break;
  }
  const unqueried=categories.filter(c=>!contexts.some(x=>x.category===c));
  const complete=!unqueried.length&&contexts.length>0&&contexts.every(c=>c.status==='complete');
  const status=complete?'complete':jobs.size||contexts.some(c=>c.pages)?'partial':'failed';
  return {company_id:source.company_id,display_name:source.display_name,checked_at:checkedAt,jobs:[...jobs.values()],
    requests:client.records,ownership_evidence:ids,bootstrap_errors:bootstrapErrors,
    coverage:{status,pages:contexts.reduce((n,c)=>n+c.pages,0),server_total:contexts.length===1?contexts[0].server_total:null,
      jobs_observed:jobs.size,list_complete:!unqueried.length&&contexts.length>0&&contexts.every(c=>c.list_complete),configured_categories:categories,unqueried_categories:unqueried,
      reason:(cfg.capabilityOnly?'capability_validation; ':'')+(unqueried.length?'unqueried_categories; ':'')+contexts.map(c=>'category '+c.category+': '+c.reason).join('; '),
      details_failed:contexts.reduce((n,c)=>n+c.details_failed,0),details_incomplete:contexts.reduce((n,c)=>n+c.details_incomplete,0),details_skipped_city:contexts.reduce((n,c)=>n+c.details_skipped_city,0),
      contexts,page_evidence:contexts.flatMap(c=>c.page_evidence)}};
}
