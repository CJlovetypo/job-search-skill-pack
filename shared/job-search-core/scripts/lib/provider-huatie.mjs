import {createClient} from './http.mjs';
import {bodyText,reviewProviderBody as reviewJobBody} from './body-review.mjs';
import {reviewRecruitment} from './recruitment-policy.mjs';
import {normalizeJobLocations} from './locations.mjs';

export function normalizeHuatieJob(row,source,record,targetMode='campus') {
  const channel=Number(row.source),type=channel===2?'校园招聘':channel===1?'社会招聘':'';
  const job=reviewRecruitment(reviewJobBody({
    provider:'huatie_public',company_id:source.company_id,company_name:source.display_name,
    job_id:String(row.id),title:bodyText(row.title),description:bodyText(row.description),requirements:bodyText(row.requirements),
    body_complete:false,formal_status:channel===1?'social':'unknown',open_status:Number(row.status)===1?'open':'closed',
    locations_raw:[row.address].filter(Boolean),official_url:'https://www.zjhuatie.cn/join/detail?id='+encodeURIComponent(row.id),
    job_url_kind:'official_detail',raw_file:record.response_file,
    recruitment_evidence:{provider:'huatie_public',recruitmentType:type,source:row.source,status:row.status,public_list_returned:true,
      source_mapping_evidence:'Official zjhuatie.cn frontend maps source=1 to 社会招聘 and source=2 to 校园招聘; each returned row carries source'},
    raw_metadata:{publish_time:row.publishTime,work_years:row.workYears,degree:row.degree,salary:row.salary,category:row.categoryText},
  }),targetMode);
  const loc=normalizeJobLocations(job);
  return {...job,cities:loc.cities,location_unknown:loc.unknown,location_special:loc.special,location_unresolved:loc.unresolved};
}

/** Public website list includes the same duties/requirements as detail.data.formInfo. */
export async function collectHuatie(source,options={}) {
  const mode=options.targetMode||'campus',channel=mode==='social'?1:2;
  if(!['campus','social','internship'].includes(mode))throw Error('Unsupported Huatie target mode');
  const size=options.pageSize||source.api_config?.page_size||10,maxPages=options.maxPages||100;
  if(!Number.isInteger(size)||size<1||!Number.isInteger(maxPages)||maxPages<1)throw Error('Huatie pagination must use positive integers');
  const client=options.client||createClient(options),jobs=new Map(),pages=[],issues=[];
  let total=null,complete=false;
  try {
    for(let page=1;page<=maxPages;page++) {
      const url=new URL('/api/htwww/job/list',source.api_config?.origin||'https://production-api.dahuangf.com');
      for(const [key,value] of Object.entries({status:1,source:channel,current:page,size,keywords:options.keyword||''}))url.searchParams.set(key,String(value));
      const r=await client.request({url:url.href,headers:{'Content-Type':'application/json'}},{purpose:'public_job_list_with_full_bodies'}),d=r.data;
      if(r.record.http_status!==200||Number(d?.code)!==200||!Array.isArray(d?.data?.list))throw Error('Huatie API rejected list: HTTP '+r.record.http_status+' code '+d?.code);
      const rows=d.data.list,pager=d.data.pager;
      if(!Number.isInteger(pager?.total)||pager.total<0||Number(pager.current)!==page||Number(pager.size)!==size)throw Error('Huatie pagination metadata mismatch');
      if(total!==null&&total!==pager.total)throw Error('Huatie server total changed during pagination');
      total=pager.total;
      if(rows.some(row=>row.id===null||row.id===undefined||String(row.id)===''||Number(row.source)!==channel||Number(row.status)!==1))throw Error('Huatie returned row outside requested source/status or missing stable ID');
      if(new Set(rows.map(row=>String(row.id))).size!==rows.length)throw Error('Huatie duplicate IDs within page');
      const before=jobs.size,ids=[];
      for(const row of rows){const job=normalizeHuatieJob(row,source,r.record,mode);ids.push(job.job_id);jobs.set(job.job_id,job);}
      pages.push({page,job_ids:ids,new_ids:jobs.size-before,server_total:total,response_file:r.record.response_file});
      if(jobs.size===total){complete=true;break;}
      if(jobs.size>total||jobs.size===before||rows.length<size){issues.push('unique_ids_do_not_reconcile_server_total');break;}
    }
  }catch(error){issues.push(error.message);}
  if(!complete&&!issues.length)issues.push('max_pages_reached');
  const incomplete=[...jobs.values()].filter(j=>!j.body_complete).length;
  if(options.mode!=='list'&&incomplete)issues.push(incomplete+' jobs have unresolved JD sections');
  if(mode==='internship')issues.push('No dedicated internship channel disclosed; only official campus inventory inspected');
  const status=complete&&!issues.length?'complete':pages.length?'partial':'failed';
  return {company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs:[...jobs.values()],requests:client.records,
    coverage:{status,pages:pages.length,server_total:total,jobs_observed:jobs.size,list_complete:complete,collection_complete:status==='complete',
      reason:issues.join('; ')||'unique_ids_reconcile_server_total',page_evidence:pages,incomplete_bodies:incomplete,
      scope:'Hainan Huatie official '+(channel===2?'campus':'social')+' recruitment channel; status=1; source='+channel,
      source_filter:{field:'source',value:channel,label:channel===2?'校园招聘':'社会招聘'}}};
}
