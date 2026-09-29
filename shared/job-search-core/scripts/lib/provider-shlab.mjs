import {createClient} from './http.mjs';
import {reviewProviderBody as reviewJobBody} from './body-review.mjs';
import {reviewRecruitment} from './recruitment-policy.mjs';
import {normalizeJobLocations} from './locations.mjs';

const clean=value=>String(value??'').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]+>/g,'').replace(/\r/g,'').trim();

function normalize(row,source,record,mode){
  const description=clean(row.description),requirements=clean(row.requirement);
  const locations=(row.address_list||[row.address]).flatMap(address=>[
    address?.city?.name?.zh_cn,address?.district?.name?.zh_cn,address?.name?.zh_cn,
  ]).filter(Boolean);
  const title=clean(row.title||row.showtitle);
  const type=row.job_recruitment_type?.name?.zh_cn||'';
  let formal_status=/实习|intern/i.test(type+' '+title)?'internship':'unknown';
  if(mode==='campus'&&!/实习|intern/i.test(type+' '+title)&&/全职/.test(type))formal_status='formal';
  const location=normalizeJobLocations({title,description,requirements,locations_raw:locations});
  return reviewRecruitment(reviewJobBody({
    job_id:String(row.id||row.job_id),company_id:source.company_id,company_name:source.display_name,title,
    description,requirements,body_complete:description.length>35&&requirements.length>20,
    locations_raw:locations,cities:location.cities,location_special:location.special,location_unknown:location.unknown,location_unresolved:location.unresolved,
    formal_status,open_status:Number(row.job_active_status)===1?'open':'closed',
    official_url:`https://www.shlab.org.cn/joinus/detail/${encodeURIComponent(row.id||row.job_id)}?mode=${encodeURIComponent(mode)}`,
    job_url_kind:'official_detail',raw_file:record.response_file,
    recruitment_evidence:{provider:'shlab_public',mode,recruitment_type:type,active_status:row.job_active_status,published_public_list:true,
      formal_basis:formal_status==='formal'?'Official campus list plus explicit full-time recruitment type':null},
    raw_metadata:{job_code:row.job_code,department:row.job_department?.name?.zh_cn,job_function:row.job_function?.name?.zh_cn,updated_at:row.updatedAtShow,other_info:row.other_info},
  }));
}

export async function collectShlab(source,options={}){
  const client=options.client||createClient(options),mode=source.api_config?.mode||'campus',limit=source.api_config?.page_size||7,maxPages=options.maxPages||100;
  const jobs=new Map(),pages=[],issues=[];let token='',complete=false;
  try{
    for(let page=1;page<=maxPages;page++){
      const url=new URL(source.validated_api_request_examples[0].url);url.searchParams.set('mode',mode);url.searchParams.set('limit',String(limit));if(token)url.searchParams.set('page_token',token);
      const response=await client.request({url:url.href},{purpose:'public_job_list_with_full_bodies'}),data=response.data;
      if(response.record.http_status!==200||data?.errno!==0||!Array.isArray(data?.data?.items))throw Error(`Shanghai AI Lab API rejected page ${page}`);
      const before=jobs.size,ids=[];for(const row of data.data.items){const job=normalize(row,source,response.record,mode);ids.push(job.job_id);jobs.set(job.job_id,job);}
      pages.push({page,job_ids:ids,new_ids:jobs.size-before,has_more:data.data.has_more,page_token:data.data.page_token,response_file:response.record.response_file});
      if(!data.data.has_more){complete=true;break;}
      if(!data.data.page_token||jobs.size===before){issues.push('Pagination stopped before has_more=false');break;}
      token=String(data.data.page_token);
    }
  }catch(error){issues.push(error.message);}
  if(!complete&&!issues.length)issues.push('max_pages_reached');
  return {company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs:[...jobs.values()],requests:client.records,
    coverage:{status:complete?'complete':jobs.size?'partial':'failed',pages:pages.length,server_total:null,jobs_observed:jobs.size,list_complete:complete,
      reason:issues.join('; ')||'has_more_false',page_evidence:pages,scope:`Shanghai AI Lab official ${mode} job API; response rows contain full duties and requirements`}};
}
