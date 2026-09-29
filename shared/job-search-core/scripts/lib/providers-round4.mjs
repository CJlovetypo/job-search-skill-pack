import {createClient} from './http.mjs';
import {reviewProviderBody as reviewJobBody,bodyText} from './body-review.mjs';
import {reviewRecruitment} from './recruitment-policy.mjs';
import {normalizeJobLocations} from './locations.mjs';

const text=value=>bodyText(value||'');
const selectedEmployers=source=>new Set((source.api_config?.employer_names||[source.display_name]).map(String));

export function normalizeMochr(source,row,rawFile,campaign={}){
  const job=reviewRecruitment(reviewJobBody({
    job_id:`${row.zpid}:${row.zpgwid}`,
    company_id:source.company_id,
    company_name:source.display_name,
    provider:source.provider,
    title:row.gwmc||'',
    description:text(row.gwjj),
    requirements:text([row.gwyq,row.xlName&&`学历要求：${row.xlName}`,row.xwName&&`学位要求：${row.xwName}`,row.zy&&`专业要求：${row.zy}`,row.bz&&`备注：${row.bz}`].filter(Boolean).join('\n')),
    structured_body_complete:Boolean(row.gwjj&&row.gwyq),
    locations_raw:[],
    official_url:`http://gkzp.mochr.com/#/zpdw?id=${encodeURIComponent(row.zpid||'')}`,
    job_url_kind:'official_listing',
    formal_status:/应届毕业生/.test(row.zpfwName||'')?'formal':/社会人员/.test(row.zpfwName||'')?'social':'unknown',
    open_status:/结束/.test(campaign.zpzt||'')?'closed':/报名中|招聘中|进行中/.test(campaign.zpzt||'')?'open':'unknown',
    raw_file:rawFile,
    recruitment_evidence:{candidate_scope:row.zpfwName,campaign_title:campaign.ztmc,campaign_status:campaign.zpzt,public_task_id:row.zpid},
    raw_metadata:{employer_name:row.dwmc,employer_id:row.zpdwid,job_category:row.gwlbName,job_grade:row.gwdj,headcount:row.pyrs,student_origin:row.sydName,education:row.xlName,degree:row.xwName,major:row.zy,registration_start:campaign.bmksrq,registration_end:campaign.bmjzrq},
  }));
  if(job.structured_body_complete&&text(job.description).length>=8&&text(job.requirements).length>=8){
    job.body_complete=true;
    job.body_review={...job.body_review,rules:[...new Set([...(job.body_review?.rules||[]),'provider_distinct_duty_requirement_fields'])],reason:'官方接口以岗位简介和岗位要求两个独立字段返回完整正文。'};
  }
  delete job.structured_body_complete;
  const loc=normalizeJobLocations(job);
  return {...job,cities:loc.cities,location_unknown:loc.unknown,location_unresolved:loc.unresolved,location_special:loc.special,location_evidence:loc.structured_evidence};
}

export function normalizeHkc(source,row,rawFile){
  const body=text(row.introduce),job=reviewRecruitment(reviewJobBody({job_id:String(row.positionId||row.pkId),company_id:source.company_id,company_name:source.display_name,provider:source.provider,title:row.name||'',description:body,requirements:'',locations_raw:[row.cityName].filter(Boolean),official_url:`http://joinus.hkcqjy.com.cn/#/app/mine/deliveryProcess?pkId=${encodeURIComponent(row.positionId||row.pkId||'')}&category=1`,job_url_kind:'official_detail',formal_status:String(row.recruitCategory)==='1'?'formal':'unknown',open_status:'open',raw_file:rawFile,recruitment_evidence:{recruit_category:row.recruitCategory,current_public_list:true,work_experience:row.workExpStr},raw_metadata:{employer_name:row.companyName,address:row.address,education:row.education,headcount:row.recruitNum,category:row.schoolCategory,released_at:row.releaseTime,close_at:row.endTime}}));
  const loc=normalizeJobLocations(job);return {...job,cities:loc.cities,location_unknown:loc.unknown,location_unresolved:loc.unresolved,location_special:loc.special,location_evidence:loc.structured_evidence};
}

async function collectMochr(source,client){
  const employers=selectedEmployers(source),tasks=new Map(),pages=[];let total=null,reason='max_pages_reached';
  for(let page=1;page<=100;page++){
    const response=await client.request({url:'http://gkzp.mochr.com/api/v1/zjbwz-wy/wygl_zprwxxList',method:'POST',headers:{Referer:'http://gkzp.mochr.com/#/jobQuiry'},body:{page,pageSize:100}},{purpose:'recruitment_campaign_list'});
    const rows=response.data?.data?.value;if(response.data?.code!==1||!Array.isArray(rows))throw new Error(response.data?.msg||'invalid MOCHR campaign list');
    total=Number(response.data.data.total);const before=tasks.size;for(const row of rows)if(row.id)tasks.set(String(row.id),row);
    pages.push({page,job_ids:rows.map(row=>String(row.id||'')),new_ids:tasks.size-before,response_file:response.record.response_file});
    if(!rows.length||Number.isFinite(total)&&tasks.size>=total){reason='campaign_total_reconciled';break;}
    if(tasks.size===before){reason='repeated_campaign_page';break;}
  }
  const jobs=new Map(),campaignEvidence=[];
  for(const campaign of tasks.values()){
    const response=await client.request({url:'http://gkzp.mochr.com/api/v1/zjbwz-wy/wygl_gwbmxxCx',method:'POST',headers:{Referer:`http://gkzp.mochr.com/#/zpdw?id=${encodeURIComponent(campaign.id)}`},body:{zpid:campaign.id}},{purpose:'job_list_full_body'});
    const rows=response.data?.data?.gwxxList;if(response.data?.code!==1||!Array.isArray(rows))throw new Error(response.data?.msg||`invalid MOCHR job list ${campaign.id}`);
    let selected=0;for(const row of rows){if(!employers.has(String(row.dwmc)))continue;selected++;const job=normalizeMochr(source,row,response.record.response_file,campaign);jobs.set(job.job_id,job);}
    campaignEvidence.push({campaign_id:campaign.id,campaign_title:campaign.ztmc,campaign_status:campaign.zpzt,rows:rows.length,selected,response_file:response.record.response_file});
  }
  const listComplete=Number.isFinite(total)&&tasks.size===total&&reason==='campaign_total_reconciled';
  const incomplete=[...jobs.values()].filter(job=>!job.body_complete).length;
  return {jobs:[...jobs.values()],coverage:{status:listComplete&&!incomplete?'complete':'partial',pages:pages.length+tasks.size,server_total:null,jobs_observed:jobs.size,list_complete:listComplete,reason:!listComplete?reason:incomplete?`${incomplete} selected jobs omit duties or requirements`:'all_campaigns_reconciled_and_exact_employer_filter_applied',page_evidence:pages,campaign_evidence:campaignEvidence,details_failed:0,scope:'住房城乡建设部公开招聘匿名 API；完整枚举招聘任务，再按招聘单位精确筛选岗位；岗位列表直接提供职责、要求和招聘对象。'}};
}

async function collectHkc(source,client,options){
  const jobs=new Map(),pages=[];let total=null,reason='max_pages_reached';
  for(let page=1;page<=100;page++){
    const response=await client.request({url:'http://joinus.hkcqjy.com.cn/recruit-api/admin/homepage/positions',method:'POST',headers:{Referer:'http://joinus.hkcqjy.com.cn/','Accept-Language':'zh-CN'},body:{pageIndex:page,pageSize:100,recruitCategory:1,nameOrCityName:'',releaseChannel:2}},{purpose:'campus_job_list'});
    const rows=response.data?.result?.records;if(response.data?.code!==200||!Array.isArray(rows))throw new Error(response.data?.message||'invalid HKC list');
    total=Number(response.data.result.total);const before=jobs.size;for(const row of rows)if(row.pkId)jobs.set(String(row.pkId),normalizeHkc(source,row,response.record.response_file));
    pages.push({page,job_ids:rows.map(row=>String(row.pkId||'')),new_ids:jobs.size-before,response_file:response.record.response_file});
    if(!rows.length||Number.isFinite(total)&&jobs.size>=total){reason='job_total_reconciled';break;}if(jobs.size===before){reason='repeated_job_page';break;}
  }
  let detailsFailed=0;if(options.mode==='full'){
    const pending=[...jobs.entries()].filter(([,job])=>!job.body_complete);let cursor=0;
    await Promise.all(Array.from({length:6},async()=>{while(cursor<pending.length){const [id,previous]=pending[cursor++];try{const response=await client.request({url:`http://joinus.hkcqjy.com.cn/recruit-api/admin/position/position?pkId=${encodeURIComponent(id)}`,headers:{Referer:previous.official_url,'Accept-Language':'zh-CN'}},{purpose:'job_detail_full_body'});if(response.data?.code!==200||!response.data?.result)throw new Error(response.data?.message||'invalid HKC detail');jobs.set(id,normalizeHkc(source,response.data.result,response.record.response_file));}catch{detailsFailed++;}}}));
  }
  const listComplete=Number.isFinite(total)&&jobs.size===total&&reason==='job_total_reconciled',incomplete=[...jobs.values()].filter(job=>!job.body_complete).length;
  return {jobs:[...jobs.values()],coverage:{status:listComplete&&!detailsFailed&&!incomplete?'complete':'partial',pages:pages.length,server_total:Number.isFinite(total)?total:null,jobs_observed:jobs.size,list_complete:listComplete,reason:!listComplete?reason:detailsFailed?`${detailsFailed} detail requests failed`:incomplete?`${incomplete} current campus rows omit a distinct duty or requirement section`:'all_campus_pages_and_bodies_reconciled',details_failed:detailsFailed,page_evidence:pages,scope:'惠科匿名招聘 API；recruitCategory=1 为校招，完整分页并对正文不足的列表行请求公开详情。'}};
}

export async function collectRound4(source,options={}){
  if(!['mochr_public','hkc_public'].includes(source.provider))return null;
  const client=options.client||createClient({evidenceDir:options.evidenceDir,timeoutMs:options.timeoutMs||20000});
  const partial=source.provider==='mochr_public'?await collectMochr(source,client):await collectHkc(source,client,options);
  return {company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),requests:client.records,...partial};
}
