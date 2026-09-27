import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {requestSlot,retryAfterMs,recruitmentLink} from './lib/waiqi-utils.mjs';

// Anonymous public read endpoints observed in waiqi.com's company frontend.
const output=path.resolve(process.argv[2]||'shared/job-search-core/state/maintenance/waiqi-2026-09-20');
const base='https://backservice.offerxiansheng.com/api/position-service';
const concurrency=Number(process.env.WAIQI_CONCURRENCY||3);
const interval=Number(process.env.WAIQI_INTERVAL_MS||750);
const refreshCatalog=process.env.WAIQI_REFRESH_CATALOG==='1';
const refreshCompanies=process.env.WAIQI_REFRESH_COMPANIES==='1';
const refreshPositions=process.env.WAIQI_REFRESH_POSITIONS==='1';
if(!Number.isInteger(concurrency)||concurrency<1||!Number.isFinite(interval)||interval<0)throw Error('Invalid WAIQI_CONCURRENCY or WAIQI_INTERVAL_MS');
let nextRequest=0,cooldownUntil=0;
async function throttle(){
  while(true){
    const slot=requestSlot(Date.now(),nextRequest,cooldownUntil,interval);
    if(!slot.waitMs){nextRequest=slot.nextRequest;return;}
    await new Promise(r=>setTimeout(r,slot.waitMs));
  }
}
const hash=s=>createHash('sha256').update(s).digest('hex');
await fs.mkdir(output,{recursive:true});
const write=async(file,data)=>{const p=path.join(output,file);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(data,null,2)+'\n');};
const read=async file=>{try{return JSON.parse(await fs.readFile(path.join(output,file),'utf8'));}catch{return null;}};
async function request(key,route,body,acceptCached=cached=>cached?.success){
  const cached=await read(key);if(acceptCached(cached))return cached.data;
  for(let attempt=0;attempt<4;attempt++){
    try{
      await throttle();
      const url=base+route;const r=await fetch(url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',source:'24'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
      const coolDown=()=>{const delay=Math.max(60000*(attempt+1),retryAfterMs(r.headers.get('retry-after')));cooldownUntil=Math.max(cooldownUntil,Date.now()+delay);console.log(JSON.stringify({phase:'rate_limit_cooldown',seconds:Math.ceil(delay/1000)}));};
      // HTTP throttling must be recognized even when the body is HTML or empty.
      if(r.status===429)coolDown();
      const text=await r.text();let j;try{j=JSON.parse(text);}catch{throw Error(`HTTP ${r.status}: response is not JSON`);}
      if(r.status!==429&&Number(j.code)===429)coolDown();
      if(!r.ok||![0,200,1000].includes(j.code)||j.data==null)throw Error(`HTTP ${r.status}, code ${j.code}: ${j.message}`);
      await write(key,{success:true,fetched_at:new Date().toISOString(),request:{url,method:body?'POST':'GET',body},response_sha256:hash(text),data:j.data});
      await new Promise(r=>setTimeout(r,150));return j.data;
    }catch(e){if(attempt===3){await write(key,{success:false,error:String(e),attempted_at:new Date().toISOString()});throw e;}await new Promise(r=>setTimeout(r,1000*(attempt+1)));}
  }
}
const companies=new Map();let total=Infinity;
for(let page=1;page<=Math.ceil(total/100);page++){
  const data=await request(`lists/${page}.json`,'/company/foreign/search',{cityId:'',businessDictIdList:[],companyTypeList:[],posInfoIdList:[],workExpList:[],educationList:[],page,size:100,needAd:0},refreshCatalog?()=>false:undefined);
  total=data.page.total;const rows=data.page.records.filter(x=>x.id);let added=0;
  for(const row of rows){if(!companies.has(row.id))added++;companies.set(row.id,row);}
  console.log(JSON.stringify({phase:'list',page,total,rows:rows.length,unique:companies.size}));
  if(!rows.length||!added)break;
}
await write('company-list.json',{reported_total:total,unique_count:companies.size,companies:[...companies.values()]});
let cursor=0,done=0,errors=0;const items=[...companies.values()];
await Promise.all(Array.from({length:concurrency},async()=>{
  while(cursor<items.length){const row=items[cursor++];
    let detail;
    try{detail=await request(`companies/${row.id}.json`,`/company/info?id=${row.id}`,undefined,refreshCompanies?()=>false:undefined);}catch{errors++;}
    // company/info.positionCount can be stale even when the company page exposes jobs.
    // Only an actual position-all response is accepted as the position observation.
    try{await request(`positions/${row.id}.json`,`/company/position-all?companyId=${row.id}`,undefined,refreshPositions?()=>false:cached=>cached?.success&&cached.observation_kind!=='company_info_reports_zero_positions');}catch{errors++;}
    done++;if(done%50===0||done===items.length)console.log(JSON.stringify({phase:'companies',done,total:items.length,errors}));
  }
}));
// Site-hosted listings with no usable external URL need their own detail page.
// For an explicitly requested full JD mirror, WAIQI_JOB_DETAILS=all is resumable.
const detailMode=process.env.WAIQI_JOB_DETAILS||'none';
const detailJobs=new Map();
if(detailMode!=='none')for(const row of items){const response=await read(`positions/${row.id}.json`);if(!response?.success)continue;for(const j of response.data||[])if(j.id&&(detailMode==='all'||!recruitmentLink(j.outsideUrl).url))detailJobs.set(`${j.posType||1}-${j.id}`,j);}
const queue=[...detailJobs];let detailCursor=0,detailDone=0,detailErrors=0;
await Promise.all(Array.from({length:concurrency},async()=>{while(detailCursor<queue.length){const [key,j]=queue[detailCursor++];try{await request(`job-details/${key}.json`,`/${Number(j.posType||1)===1?'social':'campus'}-position/details?id=${j.id}`);}catch{detailErrors++;}detailDone++;if(detailDone%50===0||detailDone===queue.length)console.log(JSON.stringify({phase:'job-details',mode:detailMode,done:detailDone,total:queue.length,errors:detailErrors}));}}));
let jobDetailsCompleted=0;const pending=[];
for(const [key,j]of queue){const cached=await read(`job-details/${key}.json`);if(cached?.success)jobDetailsCompleted++;else pending.push({waiqi_job_id:j.id,waiqi_company_id:j.companyId||null,title:j.name,source_url:`https://waiqi.com/position/detail?id=${j.id}&posType=${j.posType||1}`,status:'supplemental_detail_pending'});}
await write('job-details-pending.json',pending);
await write('crawl-summary.json',{finished_at:new Date().toISOString(),reported_total:total,companies:companies.size,errors,catalog_refreshed:refreshCatalog,company_details_refreshed:refreshCompanies,position_lists_refreshed:refreshPositions,job_detail_mode:detailMode,job_details_requested:queue.length,job_details_completed:jobDetailsCompleted,job_details_deferred:pending.length,job_detail_errors:detailErrors,status:errors?'incomplete':pending.length?'directory_complete_supplemental_details_incomplete':'complete'});
