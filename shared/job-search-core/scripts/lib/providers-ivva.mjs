import {createClient} from './http.mjs';
import {normalizeJobLocations} from './locations.mjs';
import {plainJobText} from './providers-global.mjs';

export function normalizeIvvaJob(row,source) {
  const description=plainJobText(row.positionDesc),marker=description.match(/任职要求|岗位要求|职位要求|任职资格|我们重点寻找|Qualifications|Requirements/i);
  const requirements=marker?description.slice(marker.index):'';
  let formal='unknown';
  if(/实习|intern/i.test(row.positionNature||'')||/实习生|intern(?:ship)?\b/i.test(row.positionName||''))formal='internship';
  else if(Number(row.isSchoolRecruit)===1&&/^(全职|正式)$/.test(row.positionNature||''))formal='formal';
  else if(row.isSchoolRecruit===0&&row.positionNature==='全职')formal='social';
  const entry=new URL(source.primary_entry_url);entry.pathname=entry.pathname.replace(/[^/]+$/,row._portal_token);
  entry.hash='/positionDetail?positionId='+encodeURIComponent(row.positionId)+'&wt=1';
  const job={job_id:String(row.positionId),company_id:source.company_id,company_name:source.display_name,title:row.positionName,
    description,requirements,body_complete:description.length>50&&requirements.length>20,locations_raw:row.workingPlace?[row.workingPlace]:[],
    formal_status:formal,open_status:row.recruitStatus===1?'open':row.recruitStatus==null?'unknown':'closed',
    official_url:entry.href,job_url_kind:'official_detail',raw_file:row._raw_file,
    recruitment_evidence:{provider:'ivva',isSchoolRecruit:row.isSchoolRecruit,positionNature:row.positionNature,recruitStatus:row.recruitStatus},
    raw_metadata:{updated_at:row.updateTime}};
  const loc=normalizeJobLocations(job);return {...job,cities:loc.cities,location_unknown:loc.unknown,location_special:loc.special,location_unresolved:loc.unresolved};
}

export function normalizeIvvaResult(data,source) {
  const jobs=data.rows.map(row=>normalizeIvvaJob(row,source)),coverage={...data.coverage};
  const incomplete=jobs.filter(j=>!j.body_complete).map(j=>j.job_id);
  if(incomplete.length){coverage.status=coverage.status==='failed'?'failed':'partial';coverage.missing_body_ids=incomplete;coverage.reason+='; missing_full_jd_body';}
  return {company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs,requests:data.requests,coverage};
}

export async function collectIvva(source,options={}) {
  const entry=new URL(source.primary_entry_url);
  if(entry.origin!=='https://talent.biomap-inc.com')throw Error('Unsupported IVVA public portal');
  const client=createClient(options),rows=[],pages=[],seen=new Set();let total=null,complete=false,reason='max_pages_reached';
  const request=async(route,params,method='GET')=>{
    const body=new URLSearchParams(params),r=await client.request({url:entry.origin+route+(method==='GET'?'?'+body:''),method,body:method==='GET'?null:body,headers:{Referer:entry.href,'Content-Type':'application/x-www-form-urlencoded'}},{purpose:method==='GET'?'public_portal_configuration':'job_list'});
    if(r.record.http_status!==200||r.data?.success!==true)throw Error('Public IVVA API did not return success: HTTP '+r.record.http_status);
    return r;
  };
  try{
    const bootstrap=await request('/companyPortal/getCompOfficialWebsiteToken',{token:entry.pathname.replace(/\/$/,'').split('/').at(-1),isSchoolRecruit:0}),token=bootstrap.data.data?.token1;
    if(!token)throw Error('Public campus portal identifier missing');
    for(let page=1;page<=(options.maxPages||1000);page++){
      const r=await request('/companyPortal/positionSearchByPortal',{token,isSchoolRecruit:1,pageIndex:page,pageSize:30,position_recruitStatus_i:1},'POST'),items=r.data.listData,count=r.data.pageModel?.rowCount;
      if(!Array.isArray(items)||!Number.isInteger(count))throw Error('IVVA list/page totals missing');
      if(total!==null&&total!==count){reason='server_total_changed';break;}total=count;let fresh=0;
      for(const item of items){const id=String(item.positionId??'');if(!id)throw Error('Position ID missing');if(!seen.has(id)){seen.add(id);rows.push({...item,_raw_file:r.record.response_file,_portal_token:token});fresh++;}}
      pages.push({page,server_total:total,new_ids:fresh,job_ids:items.map(x=>String(x.positionId)),response_file:r.record.response_file});
      if(seen.size===total){complete=true;reason='unique_ids_reconcile_server_total';break;}
      if(!items.length||!fresh){reason='empty_or_repeated_page_before_total';break;}
    }
  }catch(error){reason=error.message;}
  return normalizeIvvaResult({rows,requests:client.records,coverage:{status:complete?'complete':pages.length?'partial':'failed',pages:pages.length,server_total:total,jobs_observed:rows.length,list_complete:complete,reason,page_evidence:pages}},source);
}
