import {createClient} from './http.mjs';
import {reviewProviderBody as reviewJobBody,bodyText} from './body-review.mjs';
import {reviewRecruitment} from './recruitment-policy.mjs';
import {normalizeJobLocations,jobCityStatus} from './locations.mjs';

const supported=new Set(['10jqka_campus','cec_campus','wenhua_public','tplink_domestic','ccb_public']);
const text=value=>bodyText(value||'');
const values=value=>Array.isArray(value)?value.filter(Boolean):[value].filter(Boolean);
const internship=/实习生|实习岗|日常实习|暑期实习|intern/i;
const graduate=/校园招聘|校招|应届|毕业生|graduate/i;
const repairCcbJson=value=>JSON.parse(String(value||'').trim().replace(
  /\s*("\w+")(\s*:\s*")((?:[^"]|"(?!\s*(?:,\s*"|})))+)(")\s*/g,
  (_match,key,colon,body,quote)=>key+colon.replace(/\s/g,'')+body.replace(/\r?\n/g,'\\n').replace(/\t/g,'\\t').replace(/"/g,'\\"')+quote));

function finish(source,job){
  job=reviewRecruitment(reviewJobBody({...job,company_id:source.company_id,company_name:source.display_name,provider:source.provider}));
  const loc=normalizeJobLocations(job);
  return {...job,cities:loc.cities,location_unknown:loc.unknown,location_unresolved:loc.unresolved,
    location_special:loc.special,location_evidence:loc.structured_evidence};
}

export function normalizeSelfHosted(source,row,rawFile){
  if(source.provider==='10jqka_campus'){
    const series=row.apply_recruitment_series_name||'';
    return finish(source,{job_id:String(row.id),title:row.name||'',description:text(row.intro),requirements:text(row.requirement),
      locations_raw:values(row.base),official_url:`https://campus.10jqka.com.cn/job/detail?id=${encodeURIComponent(row.id)}`,
      job_url_kind:'official_detail',formal_status:internship.test(series+' '+(row.name||''))?'internship':graduate.test(series)?'formal':'unknown',open_status:'open',raw_file:rawFile,
      recruitment_evidence:{apply_recruitment_series_id:row.apply_recruitment_series_id,apply_recruitment_series_name:series,public_current_list:true},
      raw_metadata:{colony:row.apply_colony_name,job_type:row.apply_type_first,urgent_recruitment:row.urgent_recruitment}});
  }
  if(source.provider==='cec_campus'){
    const kind=Number(row.positionType);
    return finish(source,{job_id:String(row.id),title:row.name||'',description:text(row.jobDescription),requirements:text(row.jobRequirements),
      locations_raw:values(row.cityName),official_url:`https://campus.cec.com.cn/positionDetail?id=${encodeURIComponent(row.id)}`,
      job_url_kind:'official_detail',formal_status:internship.test((row.name||'')+' '+(row.workNature||''))?'internship':kind===0?'formal':kind===1?'social':'unknown',
      open_status:row.expireFlag===true||row.applyable===false?'closed':row.canDeliver===true||row.applyable===true?'open':'unknown',raw_file:rawFile,
      recruitment_evidence:{position_type:kind,position_type_filter:source.api_config?.query?.positionType??0,can_deliver:row.canDeliver,applyable:row.applyable,expire_flag:row.expireFlag,
        classification_basis:'Public API positionType identifies campus (0) or social (1); retain the actual query and returned value separately.'},
      raw_metadata:{employer_name:row.org,second_level_org:row.positionSecondOrg,position_no:row.positionNo,work_nature:row.workNature,close_at:row.closeDateTime||row.closeDate}});
  }
  if(source.provider==='wenhua_public'){
    const horizontal=Object.fromEntries((row.listH||[]).map(x=>[x.name,x.note]));
    const vertical=Object.fromEntries((row.listV||[]).map(x=>[x.name,x.note]));
    const all=Object.values({...horizontal,...vertical}).join('\n');
    const description=vertical['岗位介绍']||vertical['岗位职责']||vertical['工作内容']||'';
    const requirements=vertical['招聘要求']||vertical['任职要求']||vertical['岗位要求']||vertical['招聘对象']||'';
    const location=horizontal['工作地点']||horizontal['工作地址']||'';
    return finish(source,{job_id:String(row.id),title:row.position||'',description:text(description),requirements:text(requirements),locations_raw:values(location),
      official_url:`https://hr.wenhua.com.cn/?job=${encodeURIComponent(row.id)}`,job_url_kind:'official_listing',
      formal_status:internship.test((row.position||'')+' '+all)?'internship':graduate.test(all)?'formal':'unknown',open_status:Number(row.status)===1?'open':'closed',raw_file:rawFile,
      recruitment_evidence:{status:row.status,type_sub:row.typeSub,explicit_graduate_text:graduate.test(all)},raw_metadata:{horizontal_fields:horizontal,vertical_field_names:Object.keys(vertical)}});
  }
  if(source.provider==='tplink_domestic'){
    return finish(source,{job_id:String(row.Id),title:row.JobName||'',description:text(row.Duty),requirements:text(row.Requirement),locations_raw:values(row.JobAddress),
      official_url:`https://hr.tp-link.com.cn/job/detail?id=${encodeURIComponent(row.Id)}`,job_url_kind:'official_detail',
      formal_status:internship.test(row.JobName||'')?'internship':graduate.test((row.Batch||'')+' '+(row.Education||''))||source.api_config?.campus_stream===true?'formal':'unknown',
      open_status:'open',raw_file:rawFile,recruitment_evidence:{campus_stream:source.api_config?.campus_stream===true,batch:row.Batch},
      raw_metadata:{class_id:row.ClassId,department_id:row.DepartmentId,education:row.Education,application_number:row.ApplicationNumber,work_place_id:row.WorkPlaceId}});
  }
  if(source.provider==='ccb_public'){
    const id=[row.planId,row.planPost,row.secondOrgId||row.orgId].filter(Boolean).join(':');
    const job=finish(source,{job_id:id,title:row.planPostName||'',description:text(row.postDesc),requirements:text(row.PostRequest),
      locations_raw:values(row.workPlace||row.cityName),official_url:`http://job.ccb.com/cn/job/job_detail.html?planId=${encodeURIComponent(row.planId||'')}&planPost=${encodeURIComponent(row.planPost||'')}&planType=${encodeURIComponent(row.planType||'XY')}&orgId=${encodeURIComponent(row.orgId||'')}&secondOrgId=${encodeURIComponent(row.secondOrgId||'')}`,
      job_url_kind:'official_detail',formal_status:row.planType==='XY'?'formal':row.planType==='SX'?'internship':'unknown',
      open_status:String(row.planStatus)==='1'?'open':String(row.planStatus)==='2'?'closed':'unknown',raw_file:rawFile,
      recruitment_evidence:{plan_type:row.planType,plan_name:row.planName,plan_status:row.planStatus,post_date:row.postDate,end_date:row.endDate||row.endTime},
      raw_metadata:{employer_name:row.orgName,second_level_org:row.secondOName||row.secondOrgName,plan_id:row.planId,position_id:row.planPost}});
    if(job.description.length>=20&&job.requirements.length>=20)job.body_complete=true;
    return job;
  }
  throw new Error('Unsupported self-hosted provider '+source.provider);
}

function requestFor(source,page,size){
  if(source.provider==='10jqka_campus'){
    const url=new URL('https://campus.10jqka.com.cn/api/v3/school_recruitment/apply/apply_list');
    for(const [key,value] of Object.entries({page,pageCount:size,...(source.api_config?.query||{})}))url.searchParams.set(key,String(value));
    return {url:url.href};
  }
  if(source.provider==='cec_campus')return {url:'https://campus.cec.com.cn/student-api/api/position/search',method:'POST',body:{page,size,positionType:0,...(source.api_config?.query||{})}};
  if(source.provider==='wenhua_public')return {url:'https://hr.wenhua.com.cn/api/dataapi/job?whid=wenhua',method:'POST'};
  if(source.provider==='tplink_domestic')return {url:'https://hr.tp-link.com.cn/api/v1/job/get',method:'POST',body:{jobClassId:[],jobDirectionIds:'0',keywords:'',limit:size,page,workPlaceId:0,...(source.api_config?.query||{})}};
  if(source.provider==='ccb_public'){
    const url=new URL('http://job.ccb.com/tran/WCCMainPlatV5');
    for(const [key,value] of Object.entries({CCB_IBSVersion:'V5',isAjaxRequest:'true',SERVLET_NAME:'WCCMainPlatV5',TXCODE:'NHR104',planType:'XY',PAGE_JUMP:page,REC_IN_PAGE:size,...(source.api_config?.query||{})}))url.searchParams.set(key,String(value));
    return {url:url.href,headers:{Referer:'https://job.ccb.com/cn/job/plan_index.html?planType=XY'}};
  }
}

function unpack(provider,data){
  if(provider==='10jqka_campus')return {rows:data?.ex_data?.apply_show_do_list,total:Number(data?.ex_data?.total),ok:data?.success===true&&data?.ex_data?.success!==false};
  if(provider==='cec_campus')return {rows:data?.data?.records,total:Number(data?.data?.total),ok:data?.code==='000000'};
  if(provider==='wenhua_public')return {rows:data,total:Array.isArray(data)?data.length:NaN,ok:Array.isArray(data)};
  if(provider==='tplink_domestic')return {rows:data?.result?.jobs,total:Number(data?.result?.total),ok:data?.errorCode===0};
  if(provider==='ccb_public')return {rows:data?.planPostList,total:Number(data?.TOTAL_REC),ok:data?.SUCCESS==='true'};
}

function selfHostedRowFilter(source){
  const filter=source.api_config?.employer_filter;
  if(filter==null)return ()=>true;
  if(source.provider!=='cec_campus')throw new Error('employer_filter is only supported for cec_campus');
  const fields={org:'org',positionSecondOrg:'positionSecondOrg'};
  if(!filter||typeof filter!=='object'||Array.isArray(filter)||!fields[filter.field]||!Array.isArray(filter.values)||!filter.values.length||filter.values.some(value=>typeof value!=='string'||!value.trim())){
    throw new Error('Invalid cec_campus employer_filter; expected {field:"org"|"positionSecondOrg",values:[non-empty strings]}');
  }
  const accepted=new Set(filter.values.map(value=>value.trim()));
  return row=>accepted.has(String(row?.[fields[filter.field]]||'').trim());
}

export async function collectSelfHosted(source,options={}){
  if(!supported.has(source.provider))return null;
  const cfg={pageSize:100,maxPages:100,timeoutMs:20000,...options},client=cfg.client||createClient(cfg),jobs=new Map(),rawById=new Map(),pages=[],detailFailures=[],acceptRow=selfHostedRowFilter(source),seenIds=new Set();
  let total=null,listComplete=false,reason='max_pages_reached';
  if(source.provider==='ccb_public')await client.request({url:'http://job.ccb.com/cn/job/plan_index.html?planType=XY',headers:{Referer:'http://job.ccb.com/cn/job/'}},{purpose:'public_session_bootstrap'});
  for(let page=1;page<=cfg.maxPages;page++){
    const response=await client.request(requestFor(source,page,cfg.pageSize),{purpose:'job_list_full_body'});
    const parsed=unpack(source.provider,response.data),rows=parsed.rows;
    if(response.record.http_status!==200||!parsed.ok||!Array.isArray(rows)){reason=`invalid_list_response_http_${response.record.http_status}`;break;}
    if(Number.isFinite(parsed.total))total=parsed.total;
    const before=seenIds.size,acceptedBefore=jobs.size;
    for(const row of rows){
      const job=normalizeSelfHosted(source,row,response.record.response_file);if(job.job_id)seenIds.add(job.job_id);
      if(!job.job_id||!acceptRow(row))continue;
      jobs.set(job.job_id,job);rawById.set(job.job_id,{row,list_file:response.record.response_file});
    }
    pages.push({page,rows:rows.length,new_ids:seenIds.size-before,accepted_rows:jobs.size-acceptedBefore,response_file:response.record.response_file});
    if(source.provider==='wenhua_public'||rows.length<cfg.pageSize||Number.isFinite(total)&&seenIds.size>=total){listComplete=true;reason=source.provider==='wenhua_public'?'single_complete_array':'terminal_page_or_total_reconciled';break;}
    if(seenIds.size===before){reason='repeated_page_no_new_ids';break;}
  }
  let detailsCapped=0;
  if(source.provider==='ccb_public'&&jobs.size&&cfg.mode!=='list'){
    const eligible=[...jobs.values()].filter(job=>job.open_status!=='closed'&&(!cfg.cities?.length||jobCityStatus({cities:job.cities,location_special:job.location_special,location_unknown:job.location_unknown},cfg.cities)!=='excluded'));
    const targets=eligible.slice(0,Number.isFinite(Number(cfg.maxDetails))?Math.max(0,Number(cfg.maxDetails)):eligible.length);detailsCapped=eligible.length-targets.length;
    let next=0;
    await Promise.all(Array.from({length:Math.min(6,targets.length)},async()=>{
      while(next<targets.length){const job=targets[next++],meta=rawById.get(job.job_id),row=meta.row;
        try{
          const url=new URL('http://job.ccb.com/tran/WCCMainPlatV5');
          for(const [key,value] of Object.entries({CCB_IBSVersion:'V5',isAjaxRequest:'true',SERVLET_NAME:'WCCMainPlatV5',TXCODE:'NHR107',planId:row.planId,planPost:row.planPost,planType:row.planType||'XY',orgId:row.secondOrgId||row.orgId}))url.searchParams.set(key,String(value||''));
          const response=await client.request({url:url.href,headers:{Referer:job.official_url}},{purpose:'job_detail_full_body'}),detail=response.data||repairCcbJson(response.text);
          if(response.record.http_status!==200||detail?.SUCCESS!=='true'||!detail?.postDesc||!detail?.PostRequest)throw new Error(detail?.ERRORMSG||`invalid_detail_http_${response.record.http_status}`);
          const merged={...row,...detail,workPlace:row.workPlace||detail.cityName};jobs.set(job.job_id,normalizeSelfHosted(source,merged,response.record.response_file));
        }catch(error){detailFailures.push(`${job.job_id}: ${error.message}`);}
      }
    }));
  }
  if(detailsCapped)reason+=`; detail_cap_left_${detailsCapped}`;
  if(detailFailures.length)reason+=`; detail_failures_${detailFailures.length}`;
  const status=listComplete&&!detailsCapped&&!detailFailures.length?'complete':jobs.size?'partial':'failed';
  return {company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs:[...jobs.values()],requests:client.records,
    coverage:{status,pages:pages.length,server_total:Number.isFinite(total)?total:null,jobs_observed:jobs.size,list_complete:listComplete,reason,page_evidence:pages,
      details_capped:detailsCapped,details_failed:detailFailures.length,scope:source.provider==='ccb_public'?'Anonymous first-party list and detail APIs; city-filtered runs fetch details only for in-scope locations.':source.api_config?.employer_filter?'Anonymous first-party API; every upstream list page is read before applying the configured exact employer filter.':'Anonymous first-party API; public list rows contain complete JD body fields.'}};
}
