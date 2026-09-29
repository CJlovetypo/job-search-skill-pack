import {createClient} from './http.mjs';
import {reviewJobBody,bodyText} from './body-review.mjs';
import {reviewRecruitment} from './recruitment-policy.mjs';
import {normalizeJobLocations} from './locations.mjs';

const supported=new Set(['ct108_campus','citics_campus','crec_public','sydw_public','jiuji_public','leihuo_campus','cscec8b_public','ihnhr_public']);
const text=value=>bodyText(value||'');
const values=value=>Array.isArray(value)?value.filter(Boolean):[value].filter(Boolean);

function finish(source,job){
  job=reviewRecruitment(reviewJobBody({...job,company_id:source.company_id,company_name:source.display_name,provider:source.provider}));
  if(job.structured_body_complete&&text(job.description).length>=8&&text(job.requirements).length>=8){
    job={...job,body_complete:true,body_review:{...job.body_review,rules:[...new Set([...(job.body_review?.rules||[]),'provider_distinct_duty_requirement_fields'])],
      reason:'官方接口以独立结构化字段返回岗位职责和任职条件；两字段均有有效正文。'}};
  }
  delete job.structured_body_complete;
  const loc=normalizeJobLocations(job);
  return {...job,cities:loc.cities,location_unknown:loc.unknown,location_unresolved:loc.unresolved,
    location_special:loc.special,location_evidence:loc.structured_evidence};
}

function ctRows(data){
  const rows=[];
  const walk=(value,trail=[])=>{
    if(Array.isArray(value)){for(const item of value)walk(item,trail);return;}
    if(!value||typeof value!=='object')return;
    const next=[...trail,...typeof value.name==='string'?[value.name]:[]];
    if(value.id&&value.name&&(value.jobDescription||value.responsibility))rows.push({...value,_trail:next});
    for(const child of Object.values(value))if(child&&typeof child==='object')walk(child,next);
  };
  walk(data);
  return rows;
}

export function normalizeRound3(source,row,rawFile,context={}){
  if(source.provider==='ct108_campus'){
    const stream=row._trail?.join(' / ')||'';
    return finish(source,{job_id:String(row.id),title:row.name||'',description:text(row.jobDescription),requirements:text(row.responsibility),structured_body_complete:true,locations_raw:values(source.api_config?.locations),
      official_url:`https://campus.ct108.com/position?jobId=${encodeURIComponent(row.id)}`,job_url_kind:'official_listing',formal_status:/实习/.test(stream)?'internship':'formal',
      open_status:Number(row.status)===1?'open':'closed',raw_file:rawFile,recruitment_evidence:{campus_stream:true,stream_path:stream,status:row.status},raw_metadata:{job_number:row.jobNumber}});
  }
  if(source.provider==='citics_campus'){
    const detail=context.detail||row;
    return finish(source,{job_id:[row.positionNo,row.deptNo].filter(Boolean).join(':'),title:[row.positionName,row.deptName].filter(Boolean).join('｜'),
      description:text(detail.positionDesc),requirements:text(detail.qualification),structured_body_complete:true,locations_raw:values(detail.workplace||row.workplace),
      official_url:`https://careers.citics.com/campus/${context.stream||'headquarters'}?positionNo=${encodeURIComponent(row.positionNo||'')}&deptNo=${encodeURIComponent(row.deptNo||'')}`,
      job_url_kind:'official_listing',formal_status:'formal',open_status:'open',raw_file:context.rawFile||rawFile,
      recruitment_evidence:{campus_stream:true,recruit_type:'08',batch_id:context.batchId||row.batchId,batch_title:context.batchTitle,position_type:detail.type},
      raw_metadata:{department:row.deptName,employer_name:row.companyName,deadline:row.reqendDate,position_no:row.positionNo,department_no:row.deptNo}});
  }
  if(source.provider==='crec_public'){
    return finish(source,{job_id:String(row.id),title:[row.professionalName,row.postName].filter(Boolean).join('｜')||'未命名岗位',description:text(row.postDuty),requirements:text(row.postDemand),
      structured_body_complete:true,locations_raw:values(row.workArea),official_url:`https://zhr.crec.cn/zhaopin/#/campusDetails?detail=${encodeURIComponent(row.id)}`,job_url_kind:'official_detail',
      formal_status:String(row.workType)==='10271001'?'formal':'unknown',open_status:String(row.state)==='10021001'?'open':'unknown',raw_file:rawFile,
      recruitment_evidence:{work_type:row.workType,work_type_name:row.workTypeName,api_filter:'10271001'},
      raw_metadata:{employer_name:row.companyName,pk_company:row.pkCompany,professional_category:row.professionalAtegoriesName,professional_range:row.professionRange,
        education:row.educationDemandName,salary_range:row.salaryRange,recruit_count:row.recruitNums,close_at:row.takenOffDate}});
  }
  if(source.provider==='sydw_public'){
    const eligible=/应届毕业生/.test(row.zpryfw||'');
    const description=[row.gwzz,row.gwxz&&`岗位性质：${row.gwxz}`].filter(Boolean).join('\n');
    const requirements=[row.gwyq,row.xwxlyq&&`学历要求：${row.xwxlyq}`,row.zy&&`专业要求：${row.zy}`,row.remark].filter(Boolean).join('\n');
    const viewId=context.viewId||row.ggId;
    const embeddedLocation=String(row.gwyq||'').match(/工作地点[：:]\s*([^；;，,。\s]+)/)?.[1];
    return finish(source,{job_id:[viewId,row.gwbm||row.zpgw].join(':'),title:row.zpgw||'',description:text(description),requirements:text(requirements),structured_body_complete:Boolean(row.gwzz&&row.gwyq),locations_raw:values(row.gzdd&&row.gzdd!=='-'?row.gzdd:embeddedLocation),
      official_url:`https://www.sydwgkzp.cn/mohrss/index.html#/zpDetails?yjTitles=${encodeURIComponent('招聘公告')}&ejTitles=${encodeURIComponent('招聘详情')}&viewId=${encodeURIComponent(viewId)}&type=${encodeURIComponent('招聘公告')}`,
      job_url_kind:'official_listing',formal_status:eligible?'formal':/实习/.test(row.zpryfw||'')?'internship':'social',open_status:row.BmjsFlag===false?'closed':'open',raw_file:rawFile,
      recruitment_evidence:{candidate_scope:row.zpryfw,explicit_fresh_graduate:eligible,view_id:viewId,exam_code:row.examCode},
      raw_metadata:{employer_name:row.zpdw,job_code:row.gwbm,headcount:row.pyrs,education:row.xwxlyq,major:row.zy,contact:row.lxfs}});
  }
  if(source.provider==='jiuji_public'){
    const kind=String(row.workTypeName||context.listRow?.workTypeMsg||'');
    return finish(source,{job_id:String(row.id||row.stationId),title:row.jobName||context.listRow?.jobName||'',description:text(row.duty),requirements:text(row.demand),structured_body_complete:true,
      locations_raw:values([row.city,row.area].filter(Boolean).join('')),official_url:`https://m.9ji.com/job/detail/${encodeURIComponent(row.id||row.stationId)}`,job_url_kind:'official_detail',
      formal_status:/实习/.test(kind)||/实习|校园大使/.test(row.jobName||'')?'internship':row.typeName==='校园招聘'&&/全职/.test(kind)?'formal':'unknown',open_status:'open',raw_file:rawFile,
      recruitment_evidence:{recruitment_type:row.typeName,work_type:kind,current_public_list:true},raw_metadata:{department:row.departName,category:row.categoryName,education:row.educationName,
        province:row.province,province_city_code:row.provinceCityCode,headcount:row.recruitmentNum,salary_min:row.salaryMin,salary_max:row.salaryMax,salary_unit:row.salaryUnitName,updated_at:row.updateTime}});
  }
  if(source.provider==='leihuo_campus'){
    return finish(source,{job_id:String(row.ehr_job_id),title:row.job_name||'',description:text(row.job_description),requirements:text(row.job_requirement),structured_body_complete:true,
      locations_raw:values(row.work_place_name),official_url:row.job_detail_url||`https://campus.163.com/app/detail/index?id=${encodeURIComponent(row.ehr_job_id)}&projectId=${encodeURIComponent(row.ehr_project_id||77)}`,
      job_url_kind:'official_detail',formal_status:/应届毕业生|校招/.test((row.job_target||'')+' '+(row.target||''))&&row.type_name==='全职'?'formal':/实习/.test(row.type_name||'')?'internship':'unknown',
      open_status:'open',raw_file:rawFile,recruitment_evidence:{project_id:row.ehr_project_id,job_target:row.job_target||row.target,employment_type:row.type_name,current_public_list:true},
      raw_metadata:{job_code:row.job_code,category:row.category_name,department:row.department_name,high_need:row.is_high_need,ehr_job_category:row.ehr_job_category}});
  }
  if(source.provider==='cscec8b_public'){
    const body=text(row.job_desc).replace(/\s*(岗位职责|工作职责|工作内容|任职资格|任职要求|应聘要求|基本要求|素质要求)[：:]/g,'\n$1：\n').trim();
    return finish(source,{job_id:String(row.job_id),title:row.job_name_show||'',description:body,requirements:'',locations_raw:values(row.job_address_name),
      official_url:`https://job.cscec8b.com.cn/recruitment/job/detail/id/${encodeURIComponent(row.job_id)}`,job_url_kind:'official_detail',
      formal_status:/实习/.test(row.job_name_show||'')?'internship':'formal',open_status:'open',raw_file:rawFile,
      recruitment_evidence:{jobnature_filter:2,current_public_list:true,graduation_year:(row.job_name_show||'').match(/20\d{2}届/)?.[0]||null},
      raw_metadata:{employer_name:row.ws_company_orgnize_id_user_name,degree:row.ws_g_diploma_name,published_at:row.show_time,company_param:context.companyParam,entity_id:context.entityId}});
  }
  if(source.provider==='ihnhr_public'){
    const recruitment=[row.recruitment_type_cn,row.nature_cn,row.is_graduates?'应届毕业生':''].filter(Boolean).join(' ');
    return finish(source,{job_id:String(row.job_id),title:row.job_name||'',description:text(row.contents),requirements:'',locations_raw:(row.district_list||[]).map(item=>item.area_cn).filter(Boolean),
      official_url:`https://job.ihnhr.com/job/detail?id=${encodeURIComponent(row.job_id)}`,job_url_kind:'official_detail',
      formal_status:/实习/.test(recruitment)?'internship':/校园|校招|应届/.test(recruitment)?'formal':/社会|社招/.test(recruitment)?'social':'unknown',open_status:Number(row.status)===1?'open':'unknown',raw_file:rawFile,
      recruitment_evidence:{recruitment_type:row.recruitment_type_cn,nature:row.nature_cn,is_graduates:row.is_graduates,current_public_list:true},
      raw_metadata:{employer_name:row.company_name,company_id:row.company_id,department:row.department_cn,category:row.category_cn,education:row.education_cn,experience:row.experience_cn,start_time:row.start_time,end_time:row.end_time,updated_at:row.update_time}});
  }
  throw new Error('Unsupported round-3 provider '+source.provider);
}

async function collectCt(source,client){
  const code=source.api_config?.code||'e6592c5f7b4984988332c98afe32731d';
  const response=await client.request({url:`https://campus.ct108.com/api/campusrecruit/CampusPostData?code=${encodeURIComponent(code)}`,method:'POST'},{purpose:'job_list_full_body'});
  const rows=ctRows(response.data?.data),jobs=rows.map(row=>normalizeRound3(source,row,response.record.response_file));
  return {jobs,coverage:{status:'complete',pages:1,server_total:rows.length,jobs_observed:jobs.length,list_complete:true,reason:'single_complete_tree',scope:'Anonymous first-party campus API; every leaf row includes duties and requirements.'}};
}

async function citicsList(client,params,purpose='job_list_full_body'){
  const response=await client.request({url:'https://global-kong.citics.com/api/v1/recruit/getPositionList',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8',Referer:'https://careers.citics.com/campus/'},body:new URLSearchParams({sysNo:'CSE001',pageSize:'100',pageNo:'1',...params})},{purpose});
  if(response.data?.errorCode!==0||!Array.isArray(response.data?.positionList))throw new Error(response.data?.errorMsg||'invalid CITICS list');
  return {response,rows:response.data.positionList,total:Number(response.data.count)};
}

async function collectCitics(source,client){
  const jobs=[],failures=[];
  const hq=await citicsList(client,{recruitType:'08',deptype:'Headquarter',batchId:'63',practice:'0'});
  for(const row of hq.rows)jobs.push(normalizeRound3(source,row,hq.response.record.response_file,{stream:'headquarters',batchId:63,batchTitle:'总部2027年校园招聘'}));
  const branch=await citicsList(client,{recruitType:'08',deptype:'Branch'});
  let cursor=0;
  await Promise.all(Array.from({length:6},async()=>{while(cursor<branch.rows.length){const row=branch.rows[cursor++];try{
    const response=await client.request({url:'https://global-kong.citics.com/api/v1/recruit/getPositionInfo',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8',Referer:'https://careers.citics.com/campus/branch/'},body:new URLSearchParams({sysNo:'CSE001',recruitType:'08',deptype:'Branch',positionNo:String(row.positionNo),deptNo:String(row.deptNo)})},{purpose:'job_detail_full_body'});
    if(response.data?.errorCode!==0||!response.data?.positionInfo)throw new Error(response.data?.errorMsg||'invalid detail');
    jobs.push(normalizeRound3(source,row,branch.response.record.response_file,{stream:'branch',detail:response.data.positionInfo,rawFile:response.record.response_file,batchId:response.data.batchId,batchTitle:response.data.batchTitle}));
  }catch(error){failures.push(`${row.positionNo}: ${error.message}`);}}}));
  const expected=hq.total+branch.total,status=failures.length?'partial':jobs.length===expected?'complete':'partial';
  return {jobs,coverage:{status,pages:2,server_total:expected,jobs_observed:jobs.length,list_complete:jobs.length===expected,reason:failures.length?`detail_failures_${failures.length}`:'two_current_campus_streams_reconciled',details_failed:failures.length,
    scope:'Anonymous first-party API; headquarters list rows contain complete JD and branch jobs use the public detail API.'}};
}

async function collectCrec(source,client){
  const headers={clientId:'crechr',appId:'5549',tenantId:'crechr',Referer:'https://zhr.crec.cn/zhaopin/'};
  const pkCompany=String(source.api_config?.pk_company||'');
  if(!pkCompany)throw new Error('crec_public requires api_config.pk_company');
  const url=new URL('https://zhr.crec.cn/api/hr-basic-recruit/webPage/info/postPage');
  for(const [key,value] of Object.entries({pageSize:1000,pageNum:1,workType:'10271001',pkCompany}))url.searchParams.set(key,String(value));
  const response=await client.request({url:url.href,headers},{purpose:'job_list_full_body'});
  const rows=Array.isArray(response.data?.data)?response.data.data:Array.isArray(response.data?.data?.records)?response.data.data.records:[];
  if(response.data?.code!==100000)throw new Error(response.data?.message||'invalid CREC list');
  const selected=rows.filter(row=>String(row.pkCompany)===pkCompany);
  const jobs=selected.map(row=>normalizeRound3(source,row,response.record.response_file));
  const incomplete=jobs.filter(job=>!job.body_complete).length;
  return {jobs,coverage:{status:incomplete?'partial':'complete',pages:1,server_total:selected.length,jobs_observed:jobs.length,list_complete:true,reason:incomplete?`${incomplete} of ${jobs.length} current campus rows omit duties or requirements`:'single_company_campus_list_reconciled',
    scope:'Anonymous first-party China Railway API, filtered by exact pkCompany; incomplete rows remain visible but are not eligible for detailed evaluation.'}};
}

async function collectSydw(source,client){
  const jobs=[],seen=new Set(),pages=[];
  for(const viewId of source.api_config?.view_ids||[]){
    let page=1,total=Infinity;
    while(jobs.length<total&&page<=100){
      const response=await client.request({url:'https://www.sydwgkzp.cn/mohrss/api/Affiche/GetPostSelectFyList',method:'POST',headers:{Referer:'https://www.sydwgkzp.cn/mohrss/index.html'},body:{viewId,zpdw:'',zpgw:'',xwxlyq:'',pageIndex:page,pageSize:100}},{purpose:'job_list_full_body'});
      if(!Array.isArray(response.data?.items))throw new Error('invalid public-institution list');
      total=Number(response.data.totalCount);const rows=response.data.items.filter(row=>(source.api_config?.employer_names||[source.display_name]).includes(row.zpdw));
      for(const row of rows){const job=normalizeRound3(source,row,response.record.response_file,{viewId});if(!seen.has(job.job_id)){seen.add(job.job_id);jobs.push(job);}}
      pages.push({view_id:viewId,page,rows:response.data.items.length,selected:rows.length,response_file:response.record.response_file});
      if(response.data.items.length<100||page*100>=total)break;page++;
    }
  }
  return {jobs,coverage:{status:'complete',pages:pages.length,server_total:null,jobs_observed:jobs.length,list_complete:true,reason:'all_configured_campaign_pages_reconciled_and_exact_employer_filter_applied',page_evidence:pages,
    scope:'Anonymous first-party public-institution API. Each company source is filtered by exact employer name; only rows explicitly open to fresh graduates enter formal-campus evaluation.'}};
}

async function collectJiuji(source,client){
  const base='https://m.9ji.com/cloudapi_nc/org_service/api/hrRecruitmentStation/';
  const url=new URL(base+'mobile-station-page');for(const [key,value] of Object.entries({xservicename:'oa-org',current:1,size:100,recruitmentType:2}))url.searchParams.set(key,String(value));
  const list=await client.request({url:url.href,headers:{Referer:'https://m.9ji.com/job/school/list'}},{purpose:'job_list'});
  const rows=list.data?.data?.records;
  if(list.data?.code!==0||!Array.isArray(rows))throw new Error(list.data?.userMsg||list.data?.msg||'invalid 9ji list');
  const jobs=[],failures=[];let cursor=0;
  await Promise.all(Array.from({length:6},async()=>{while(cursor<rows.length){const row=rows[cursor++];try{const detailUrl=new URL(base+'get-station-detail');detailUrl.searchParams.set('xservicename','oa-org');detailUrl.searchParams.set('stationId',row.stationId);
    const response=await client.request({url:detailUrl.href,headers:{Referer:`https://m.9ji.com/job/detail/${row.stationId}`}},{purpose:'job_detail_full_body'});
    if(response.data?.code!==0||!response.data?.data)throw new Error(response.data?.userMsg||response.data?.msg||'invalid detail');
    jobs.push(normalizeRound3(source,response.data.data,response.record.response_file,{listRow:row}));
  }catch(error){failures.push(`${row.stationId}: ${error.message}`);}}}));
  jobs.sort((a,b)=>a.job_id.localeCompare(b.job_id));
  const total=Number(list.data?.data?.total),complete=Number.isFinite(total)&&rows.length===total&&!failures.length;
  return {jobs,coverage:{status:complete?'complete':'partial',pages:1,server_total:Number.isFinite(total)?total:null,jobs_observed:jobs.length,list_complete:complete,reason:failures.length?`detail_failures_${failures.length}`:'single_page_total_reconciled_and_all_details_fetched',details_failed:failures.length,
    scope:'Anonymous first-party mobile recruitment API; recruitmentType=2 enumerates campus jobs and each current row is joined to the public detail API.'}};
}

async function collectLeihuo(source,client){
  const projectId=String(source.api_config?.project_id||77),jobs=new Map(),pages=[];let total=null,lastPage=null,reason='max_pages_reached';
  for(let page=1;page<=100;page++){
    const url=new URL('https://xiaozhao.leihuo.netease.com/api/apply/job/list/show');for(const [key,value] of Object.entries({project_id:projectId,page_number:page,page_size:100,job_name:''}))url.searchParams.set(key,String(value));
    const response=await client.request({url:url.href,headers:{Referer:'https://leihuo.163.com/campus/#/full'}},{purpose:'job_list_full_body'});
    const rows=response.data?.data?.apply_job_list;
    if(response.data?.status!==200||!Array.isArray(rows)){reason=`invalid_list_response_http_${response.record.http_status}`;break;}
    total=Number(response.data.data.count_number);lastPage=Number(response.data.data.last_page||response.data.data.pages_count);const before=jobs.size;
    for(const row of rows){const job=normalizeRound3(source,row,response.record.response_file);if(job.job_id)jobs.set(job.job_id,job);}
    pages.push({page,rows:rows.length,new_ids:jobs.size-before,response_file:response.record.response_file});
    if(rows.length<100||Number.isFinite(total)&&jobs.size>=total||Number.isFinite(lastPage)&&page>=lastPage){reason='terminal_page_or_total_reconciled';break;}
    if(jobs.size===before){reason='repeated_page_no_new_ids';break;}
  }
  const listComplete=Number.isFinite(total)&&jobs.size===total&&reason==='terminal_page_or_total_reconciled';
  return {jobs:[...jobs.values()],coverage:{status:listComplete?'complete':'partial',pages:pages.length,server_total:Number.isFinite(total)?total:null,jobs_observed:jobs.size,list_complete:listComplete,reason,page_evidence:pages,
    scope:'Anonymous first-party NetEase Leihuo campus API; current project list rows contain complete duties, requirements, city and official detail URL.'}};
}

async function collectCscec8b(source,client){
  const entityId=String(source.api_config?.entity_id||''),companyParam=String(source.api_config?.company_param||'');
  if(!entityId||!companyParam)throw new Error('cscec8b_public requires entity_id and company_param');
  const directory=await client.request({url:'https://job.cscec8b.com.cn/cscec8b/81/data/names.json',headers:{Referer:source.primary_entry_url||'https://job.cscec8b.com.cn/'}},{purpose:'company_directory'});
  const entity=directory.data?.list?.find(item=>String(item.id)===entityId);
  if(!entity||!String(entity.jobApi||'').includes(`company=${companyParam}`))throw new Error('CSCEC8B company directory identity mismatch');
  const jobs=new Map(),pages=[];let total=null,reason='max_pages_reached';
  for(let page=1;page<=100;page++){
    const url=new URL(entity.jobApi,'https://job.cscec8b.com.cn');
    for(const [key,value] of Object.entries({id:entityId,jobnature:2,p:page}))url.searchParams.set(key,String(value));
    const response=await client.request({url:url.href,headers:{Referer:source.primary_entry_url||`https://job.cscec8b.com.cn/${entity.path||''}`}},{purpose:'job_list_full_body'});
    const rows=response.data?.data?.list;
    if(response.data?.errno!==200||!Array.isArray(rows)){reason=`invalid_list_response_http_${response.record.http_status}`;break;}
    total=Number(response.data.data.total);const before=jobs.size;
    for(const row of rows){const job=normalizeRound3(source,row,response.record.response_file,{companyParam,entityId});if(job.job_id)jobs.set(job.job_id,job);}
    pages.push({page,rows:rows.length,new_ids:jobs.size-before,response_file:response.record.response_file});
    if(!rows.length||Number.isFinite(total)&&jobs.size>=total){reason='terminal_page_or_total_reconciled';break;}
    if(jobs.size===before){reason='repeated_page_no_new_ids';break;}
  }
  const listComplete=Number.isFinite(total)&&jobs.size===total&&reason==='terminal_page_or_total_reconciled';
  const complete=[...jobs.values()].filter(job=>job.body_complete).length;
  return {jobs:[...jobs.values()],coverage:{status:listComplete&&complete===jobs.size?'complete':'partial',pages:pages.length,server_total:Number.isFinite(total)?total:null,jobs_observed:jobs.size,list_complete:listComplete,reason:listComplete&&complete<jobs.size?`${jobs.size-complete} of ${jobs.size} current campus rows do not expose both duties and requirements`:reason,page_evidence:pages,
    scope:'Anonymous first-party CSCEC8B company directory and job API; jobnature=2 is campus recruitment, with exact company parameter, reconciled pagination and official detail URLs.'}};
}

async function collectIhnhr(source,client){
  const companyId=String(source.api_config?.company_id||'');if(!companyId)throw new Error('ihnhr_public requires company_id');
  const jobs=new Map(),pages=[];let total=null,reason='max_pages_reached';
  for(let page=1;page<=100;page++){
    const response=await client.request({url:'https://gp-api.iguopin.com/api/jobs/v1/list',method:'POST',headers:{Device:'pc',Version:'5.2.300',Subsite:'ihnhr',Origin:'https://job.ihnhr.com',Referer:source.primary_entry_url||'https://job.ihnhr.com/'},body:{page,page_size:100,company_id:[companyId]}},{purpose:'job_list_full_body'});
    const payload=response.data?.data,rows=payload?.list===null&&payload.total===0?[]:payload?.list;if(response.record.http_status!==200||response.data?.code!==200||!Array.isArray(rows)){reason=`invalid_list_response_http_${response.record.http_status}`;break;}
    total=Number(response.data.data.total);const before=jobs.size;
    for(const row of rows){if(String(row.company_id)!==companyId)continue;const job=normalizeRound3(source,row,response.record.response_file);if(job.job_id)jobs.set(job.job_id,job);}
    pages.push({page,rows:rows.length,new_ids:jobs.size-before,response_file:response.record.response_file});
    if(!rows.length||Number.isFinite(total)&&jobs.size>=total){reason='terminal_page_or_total_reconciled';break;}
    if(jobs.size===before){reason='repeated_page_no_new_ids';break;}
  }
  const listComplete=Number.isFinite(total)&&jobs.size===total&&reason==='terminal_page_or_total_reconciled';
  return {jobs:[...jobs.values()],coverage:{status:listComplete?'complete':'partial',pages:pages.length,server_total:Number.isFinite(total)?total:null,jobs_observed:jobs.size,list_complete:listComplete,reason,page_evidence:pages,
    scope:'Anonymous first-party IHNHR/Guopin v1 API; exact company ID, reconciled pagination, recruitment nature, work location, current body and official detail URL are returned directly.'}};
}

export async function collectRound3(source,options={}){
  if(!supported.has(source.provider))return null;
  const client=options.client||createClient({evidenceDir:options.evidenceDir,timeoutMs:options.timeoutMs||20000});
  const partial=source.provider==='ct108_campus'?await collectCt(source,client):source.provider==='citics_campus'?await collectCitics(source,client):source.provider==='crec_public'?await collectCrec(source,client):source.provider==='sydw_public'?await collectSydw(source,client):source.provider==='jiuji_public'?await collectJiuji(source,client):source.provider==='leihuo_campus'?await collectLeihuo(source,client):source.provider==='cscec8b_public'?await collectCscec8b(source,client):await collectIhnhr(source,client);
  return {company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),requests:client.records,...partial};
}
