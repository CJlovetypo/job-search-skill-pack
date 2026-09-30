import {createClient} from './http.mjs';import {splitCommonBody} from './providers-common.mjs';import {normalizeJobLocations,jobCityStatus} from './locations.mjs';
export function normalizeOracleNowcoder(d,s,record,fromPublishedList=false){let id,title,body,requirements='',loc=[],url,formal='unknown',meta={};
 if(s.provider==='oracle_recruiting'){id=d.Id;title=d.Title;body=[d.ExternalDescriptionStr,d.ExternalResponsibilitiesStr].filter(Boolean).join('\n');requirements=d.ExternalQualificationsStr||'';loc=[d.PrimaryLocation,...(d.secondaryLocations||[]).map(x=>x.Name)].filter(Boolean);url=s.api_config.origin+'/hcmUI/CandidateExperience/en/sites/'+s.api_config.site+'/job/'+id;meta={RequisitionType:d.RequisitionType,JobSchedule:d.JobSchedule,PrimaryLocationCountry:d.PrimaryLocationCountry,body_fields:['ExternalDescriptionStr','ExternalResponsibilitiesStr','ExternalQualificationsStr'].filter(k=>d[k])};if(/intern|实习/i.test(title))formal='internship';else if(/campus|graduate|应届|校招|届/i.test(title)&&/graduat|本科|硕士|学位/i.test(body+'\n'+requirements))formal='formal';}
 else {id=d.id;title=d.jobName;let ext={};try{ext=JSON.parse(d.ext||'{}');}catch{}body=ext.infos;requirements=ext.requirements;loc=d.jobCityList||[d.jobCity].filter(Boolean);url='https://www.nowcoder.com/jobs/detail/'+id;meta={companyId:d.companyId,companyName:d.recommendInternCompany?.companyName,recruitType:d.recruitType,graduationYear:d.graduationYear,durationMonths:d.durationMonths,durationDays:d.durationDays};if(d.recruitType===2||/实习|intern/i.test(title))formal='internship';else if(d.recruitType===1&&/校招|应届|毕业生|届/.test(title+' '+(body||'')+' '+requirements))formal='formal';}
 const parts=splitCommonBody(body||'',requirements),l=normalizeJobLocations({locations_raw:loc,title,...parts});
 if(s.provider==='oracle_recruiting'&&(/^\s*Learning Objectives\b/i.test(parts.requirements)||/open location,?\s*open position\.?/i.test(parts.description+'\n'+parts.requirements))){parts.body_complete=false;meta.body_review_needed='Training objectives or generic talent-pool placeholder do not establish job requirements.';}
 return{job_id:String(id||''),company_id:s.company_id,company_name:s.display_name,title:title||'',...parts,locations_raw:loc,cities:l.cities,location_special:l.special,location_unknown:l.unknown,location_unresolved:l.unresolved,official_url:url,job_url_kind:'official_detail',formal_status:formal,open_status:fromPublishedList?'open':'unknown',recruitment_evidence:{provider:s.provider,published_list_returned:fromPublishedList,...meta},raw_metadata:meta,raw_file:record.response_file};
}
export async function collectOracleNowcoder(source,options={}) {
  if(!['oracle_recruiting','nowcoder_public'].includes(source.provider))return null;
  const opts={mode:'list',pageSize:20,maxPages:100,detailConcurrency:2,timeoutMs:15000,...options};
  if(!['list','full'].includes(opts.mode))throw Error('mode must be list or full');
  for(const k of ['pageSize','maxPages','detailConcurrency'])if(!Number.isInteger(opts[k])||opts[k]<1)throw Error(k+' must be a positive integer');
  if(opts.maxDetails!=null&&(!Number.isInteger(opts.maxDetails)||opts.maxDetails<0))throw Error('maxDetails must be a nonnegative integer');
  const cities=opts.cityFilters??opts.cities??[];
  if(!Array.isArray(cities))throw Error('city filters must be an array');
  const client=opts.client||createClient(opts),jobs=[],rows=new Map(),pages=[],errors=[],cfg=source.api_config;
  const oracleGlobalCountryScan=source.provider==='oracle_recruiting'&&!cfg.location_id;
  let total=null,firstTotal=null,detailFailures=0,listComplete=false,reason='max_pages_reached';
  let detailsRequested=0,detailsSkippedMode=0,detailsSkippedCity=0,detailsSkippedLimit=0;
  const excludedLocationRows=[],excludedEmployerRows=[];
  const request=async(q,purpose)=>{const r=await client.request(q,{purpose});if(r.record.http_status!==200||!r.data)throw Error('Expected JSON HTTP '+r.record.http_status);return r;};
  try {
    for(let p=1;p<=opts.maxPages;p++) {
      let r,arr;
      if(source.provider==='oracle_recruiting') {
        const pageSize=oracleGlobalCountryScan?200:opts.pageSize,offset=(p-1)*pageSize;
        const finder='findReqs;siteNumber='+encodeURIComponent(cfg.site)+',facetsList=NONE,limit='+pageSize+',offset='+offset+(oracleGlobalCountryScan?'':',locationId='+encodeURIComponent(cfg.location_id));
        r=await request({url:cfg.origin+'/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder='+finder},oracleGlobalCountryScan?'global_job_list_for_cn_filter':'china_job_list');
        const first=r.data.items?.[0];arr=first?.requisitionList;total=Number(first?.TotalJobsCount);
      }else {
        r=await request({url:'https://nowpick.nowcoder.com/u/company/job/list/v2',method:'POST',body:new URLSearchParams({companyId:String(cfg.company_id),recruitType:'0',page:String(p),pageSize:String(opts.pageSize)}),headers:{'Content-Type':'application/x-www-form-urlencoded'}},'company_job_list_full_JD');
        if(r.data.code!==0)throw Error('Nowcoder returned '+r.data.code);
        arr=r.data.data?.datas?.map(x=>x.data)||r.data.data?.records?.map(x=>x.data);total=Number(r.data.data?.totalCount);
      }
      if(!Array.isArray(arr)||!Number.isFinite(total))throw Error('Missing API list/total');
      if(firstTotal===null)firstTotal=total;else if(total!==firstTotal)errors.push('server_total_changed');
      const ids=arr.map(x=>String(x.Id||x.id||'')),before=rows.size;
      if(ids.some(id=>rows.has(id))||new Set(ids).size!==ids.length)errors.push('duplicate_job_ids_across_pages');
      arr.forEach((x,i)=>{if(ids[i])rows.set(ids[i],{data:x,record:r.record});});
      pages.push({page:p,job_ids:ids,server_total:total,response_file:r.record.response_file,new_ids:rows.size-before});
      if(ids.some(x=>!x)){reason='missing_ids';errors.push(reason);break;}
      if(rows.size===total){listComplete=!errors.length;reason='unique_ids_reconcile_total';break;}
      if(rows.size===before||!arr.length){reason='empty_or_repeated_before_total';break;}
    }
  }catch(e){reason=e.message;errors.push(e.message);}
  // Retain the acquired list when pagination fails, and enrich only when full mode needs it.
  const queue=[...rows.values()];let i=0;
  await Promise.all(Array.from({length:opts.detailConcurrency},async()=>{
    while(i<queue.length) {
      const row=queue[i++];let j=normalizeOracleNowcoder(row.data,source,row.record,true);
      j.list_raw_file=row.record.response_file;
      // Keep the existing China/employer ownership checks before applying city optimizations.
      if(source.provider==='oracle_recruiting'&&row.data.PrimaryLocationCountry!=='CN') {
        if(!oracleGlobalCountryScan)errors.push('Explicit non-China row excluded '+row.data.Id);
        excludedLocationRows.push({job_id:String(row.data.Id),country:row.data.PrimaryLocationCountry??null,response_file:row.record.response_file,reason:oracleGlobalCountryScan?'Global Oracle scan retained only explicit CN rows':'Existing explicit-CN scope check not satisfied'});continue;
      }
      if(source.provider==='nowcoder_public'&&Number(row.data.companyId)!==Number(cfg.company_id)) {
        errors.push('Nowcoder employer mismatch');
        excludedEmployerRows.push({job_id:String(row.data.id),expected_company_id:cfg.company_id,returned_company_id:row.data.companyId??null,response_file:row.record.response_file,reason:'Nowcoder employer mismatch'});
        // Wrong-employer content must never reach body re-review or candidate assessment.
        continue;
      }
      try {
        if(opts.mode==='full'&&cities.length&&jobCityStatus(j,cities)==='excluded') {
          j.detail_skipped_reason='explicit_non_target_city';detailsSkippedCity++;
        }else if(source.provider==='oracle_recruiting') {
          const needsMetadata=j.location_unknown||jobCityStatus(j,[])==='unknown'||j.formal_status==='unknown'||j.open_status==='unknown';
          if(opts.mode==='list'&&!needsMetadata){j.detail_skipped_reason='list_metadata_sufficient';detailsSkippedMode++;}
          else if(opts.maxDetails!=null&&detailsRequested>=opts.maxDetails){j.detail_skipped_reason='detail_limit';detailsSkippedLimit++;}
          else {
            detailsRequested++;
            const r=await request({url:cfg.origin+'/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22'+row.data.Id+'%22,siteNumber='+cfg.site},'job_detail');
            const d=r.data.items?.[0];
            if(!d||String(d.Id)!==String(row.data.Id))throw Error('Oracle detail ID mismatch');
            const merged={...row.data,...Object.fromEntries(Object.entries(d).filter(([,v])=>v!==undefined&&v!==null))};
            merged.PrimaryLocation=d.PrimaryLocation||row.data.PrimaryLocation;
            merged.secondaryLocations=[...new Map([...(row.data.secondaryLocations||[]),...(d.secondaryLocations||[]),{Name:row.data.PrimaryLocation}].filter(x=>x.Name&&x.Name!==merged.PrimaryLocation).map(x=>[x.Name,x])).values()];
            j=normalizeOracleNowcoder(merged,source,r.record,true);j.list_raw_file=row.record.response_file;
          }
        }
      }catch(e){errors.push(e.message);detailFailures++;j.body_complete=false;j.raw_metadata.detail_fetch_error=e.message;}
      jobs.push(j);
    }
  }));
  const incomplete=jobs.filter(j=>!j.body_complete).length;
  const requiredIncomplete=opts.mode==='full'?jobs.filter(j=>!j.body_complete&&!['explicit_non_target_city','detail_limit'].includes(j.detail_skipped_reason)).length:0;
  if(requiredIncomplete)errors.push(requiredIncomplete+' required JD bodies need section review');
  return {company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs,requests:client.records,
    coverage:{status:listComplete&&!errors.length&&!detailsSkippedLimit?'complete':pages.length?'partial':'failed',mode:opts.mode,city_filters:cities,pages:pages.length,
      server_total:total,jobs_observed:jobs.length,list_complete:listComplete,reason:[reason,...errors,detailsSkippedLimit?'detail_limit_reached':null].filter(Boolean).join('; '),page_evidence:pages,
      details_requested:detailsRequested,details_failed:detailFailures,details_skipped_mode:detailsSkippedMode,details_skipped_city:source.provider==='oracle_recruiting'?detailsSkippedCity:0,jobs_outside_city:detailsSkippedCity,
      details_skipped_limit:detailsSkippedLimit,
      incomplete_bodies:incomplete,required_incomplete_bodies:requiredIncomplete,excluded_location_rows:excludedLocationRows,excluded_employer_rows:excludedEmployerRows,
      metadata_unresolved:jobs.filter(j=>j.location_unknown||jobCityStatus(j,[])==='unknown'||j.formal_status==='unknown'||j.open_status==='unknown').length,
      global_rows_observed:source.provider==='oracle_recruiting'&&oracleGlobalCountryScan?rows.size:null,
      scope:source.provider==='oracle_recruiting'?(oracleGlobalCountryScan?'Complete global Oracle site pagination with explicit per-row CN country filter':'Explicit China location filter and per-row country check'):'Explicit employer ID all recruitment types'}};
}
