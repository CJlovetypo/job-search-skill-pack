import {createClient} from './http.mjs';
import {reviewProviderBody as reviewJobBody,bodyText} from './body-review.mjs';
import {reviewRecruitment} from './recruitment-policy.mjs';
import {normalizeJobLocations} from './locations.mjs';
import {createCipheriv,createDecipheriv} from 'node:crypto';

function decode(value){
  if(typeof value!=='string'||value.length<5)throw new Error('HCMCloud response has no encoded payload');
  return JSON.parse(Buffer.from(value.slice(3),'base64').toString('utf8'));
}
function sceneKeys(html){
  const encoded=html.match(/(?:window\.)?scene_ext\s*=\s*["']([^"']+)["']/i)?.[1];
  if(!encoded)return null;
  try{
    let middle=encoded.slice(10,-10);while(middle.length%4)middle+='=';
    const parts=Buffer.from(middle,'base64').toString('utf8').split('').reverse().join('').split('|');
    if(parts.length<4||![16,24,32].includes(Buffer.byteLength(parts[0]))||Buffer.byteLength(parts[3])!==16)return null;
    return {defaultKey:parts[0],ha5Key:parts[1],hs4Key:parts[2],iv:parts[3]};
  }catch{return null;}
}
function aesEncrypt(value,key,iv){
  const cipher=createCipheriv(`aes-${Buffer.byteLength(key)*8}-cbc`,Buffer.from(key,'utf8'),Buffer.from(iv,'utf8'));
  return Buffer.concat([cipher.update(value,'utf8'),cipher.final()]).toString('base64');
}
function aesDecrypt(value,key,iv){
  const decipher=createDecipheriv(`aes-${Buffer.byteLength(key)*8}-cbc`,Buffer.from(key,'utf8'),Buffer.from(iv,'utf8'));
  return Buffer.concat([decipher.update(value,'base64'),decipher.final()]).toString('utf8');
}
function swapHa5Encode(value){return value.replaceAll('a','!').replaceAll('5','a');}
function swapHa5Decode(value){return value.replaceAll('a','5').replaceAll('!','a');}
function encodePayload(value,strategy,keys){
  if(['hb4','base64'].includes(strategy))return {hcm_transfer_strategy:strategy,hcm_param:'cod'+Buffer.from(JSON.stringify(value),'utf8').toString('base64')};
  const key=strategy==='ha5'?keys?.ha5Key:keys?.defaultKey;
  if(!key||!keys?.iv)throw new Error(`HCMCloud ${strategy} scene_ext key material unavailable`);
  const base64Json=Buffer.from(JSON.stringify(value),'utf8').toString('base64');
  let encrypted=aesEncrypt(base64Json,key,keys.iv);
  if(strategy==='ha5')encrypted='cod'+swapHa5Encode(encrypted);
  return {hcm_transfer_strategy:strategy,hcm_param:encrypted};
}
function decodePayload(data,strategy,keys){
  const value=data?.hcm_param;
  if(typeof value!=='string')throw new Error('HCMCloud response has no encoded payload');
  // The response marker is authoritative.  Some HA/HA5 tenants return HB5
  // for short or empty responses even though the request uses AES.
  const marker=String(data?.hcm_transfer_strategy||strategy).toLowerCase();
  if(['hb4','base64'].includes(marker))return decode(value);
  if(marker==='hb5')return JSON.parse(Buffer.from(swapHa5Decode(value.slice(3)),'base64').toString('utf8'));
  const key=marker==='ha5'?keys?.ha5Key:keys?.defaultKey;
  if(!key||!keys?.iv)throw new Error(`HCMCloud ${marker} scene_ext key material unavailable`);
  let outer=marker==='ha5'?swapHa5Decode(value.slice(3)):value;
  const encrypted=Buffer.from(outer,'base64').toString('utf8');
  return JSON.parse(aesDecrypt(encrypted,key,keys.iv));
}
export const hcmcloudProtocol={sceneKeys,encodePayload,decodePayload};
function payload(page,pageSize,contractUnit,targetMode){
  const channel=targetMode==='social'?'social':'campus';
  const filter={job_class:channel==='social'?'社会招聘':'校园招聘',status:'1',delivery:1,contract_unit:contractUnit??null};
  return {model:'ReleaseJobMgr',filter_str:'',filter_dict:filter,page_index:page,page_size:pageSize,
    extra_property:{state:'portal_'+channel,sorts:[{type:'desc',key:'is_top'},{key:'release_date',type:'desc'},{type:'desc',key:'id'}],
      filter_params:{job_class:channel,tree_id:null,page_index:page,page_size:pageSize,filter_str:'',show_fields_key:[]},only_list:true},biz_type:'list'};
}
function normalize(row,source,rawFile){
  const description=bodyText(row.job_desc||row.remarks||'');
  const requirements=bodyText([
    row.professional&&`专业要求：${row.professional}`,
    row.u_job_major&&`专业要求：${row.u_job_major}`,
    row.background&&`学历要求：${row.background}`,
    row.u_Job_qulifi&&`任职资格：${row.u_Job_qulifi}`,
    row.capability_require&&`能力要求：${row.capability_require}`,
    row.u_zwyq&&`职位要求：${row.u_zwyq}`,
    row.u_zyzgyq&&`职业资格要求：${row.u_zyzgyq}`,
  ].filter(Boolean).join('\n'));
  const locationsRaw=(row.address_multi?.length?row.address_multi:[row.work_city,row.work_address]).filter(Boolean);
  const cfg=source.api_config||{},origin=new URL(source.primary_entry_url).origin;
  const qs=new URLSearchParams({id:String(row.id)});if(cfg.contract_unit)qs.set('contract_unit',String(cfg.contract_unit));
  let job={company_id:source.company_id,company_name:source.display_name,provider:'hcmcloud_public',job_id:String(row.id||''),title:row.name||'',description,requirements,
    locations_raw:locationsRaw,official_url:`${origin}/recruit#/portal_job_detail?${qs}`,job_url_kind:'official_detail',raw_file:rawFile,
    formal_status:/校园招聘/.test(row.job_class||'')?'formal':'unknown',open_status:'open',
    recruitment_evidence:{provider:'hcmcloud_public',job_class:row.job_class,status:row.status,delivery:row.delivery,public_list_returned:true,
      classification_basis:'Public campus list job_class field and current status/delivery filters.'},
    raw_metadata:{department:row.department_name||row.departm?.name,job_category:row.job_categ?.name,education:row.background,
      published_at:row.release_date,recruit_number:row.recruit_number,contract_unit:cfg.contract_unit??row.contract_unit,company_id:row.company_id}};
  job=reviewRecruitment(reviewJobBody(job));const loc=normalizeJobLocations(job);
  return {...job,cities:loc.cities,location_unknown:loc.unknown,location_unresolved:loc.unresolved,location_special:loc.special,location_evidence:loc.structured_evidence};
}

export async function collectHcmCloud(source,options={}){
  if(source.provider!=='hcmcloud_public')return null;
  const cfg={pageSize:100,maxPages:100,timeoutMs:20000,detailConcurrency:6,...options},client=cfg.client||createClient(cfg),origin=new URL(source.primary_entry_url).origin;
  const errors=[],pages=[],jobs=new Map();let listComplete=false,reason='max_pages_reached',companyName='',detailsFailed=0;
  try{
    const boot=await client.request({url:source.primary_entry_url,headers:{Accept:'text/html'}},{purpose:'public_configuration_bootstrap'});
    if(boot.record.http_status!==200)throw new Error('HCMCloud bootstrap HTTP '+boot.record.http_status);
    const keys=sceneKeys(boot.text);
    const auth=await client.request({url:origin+'/api/auth/get_auth?app_type=recruit&hcm_transfer_strategy=hb4',headers:{Referer:source.primary_entry_url,Accept:'application/json'}},{purpose:'public_anonymous_auth'});
    if(auth.record.http_status!==200||!auth.data?.company)throw new Error('HCMCloud anonymous auth failed');
    companyName=auth.data.company.special_title||auth.data.company.name||'';
    const strategy=String(auth.data.company_setting?.hcm_transfer_strategy||'no').toLowerCase();
    if(!['hb4','base64','no','aes','ha','ha4','ha5'].includes(strategy))throw new Error('Unsupported HCMCloud transfer strategy '+strategy);
    for(let page=1;page<=cfg.maxPages;page++){
      const plain=payload(page,cfg.pageSize,source.api_config?.contract_unit,source.api_config?.target_mode);
      const body=strategy==='no'?plain:encodePayload(plain,strategy,keys);
      const response=await client.request({url:origin+'/api/hcm.model.list?model=ReleaseJobMgr',method:'POST',headers:{Accept:'application/json, text/plain, */*','Content-Type':'application/json;charset=utf-8',Origin:origin,Referer:source.primary_entry_url},body},{purpose:'job_list'});
      if(response.record.http_status!==200)throw new Error('HCMCloud list HTTP '+response.record.http_status);
      const decoded=strategy==='no'?response.data:decodePayload(response.data,strategy,keys),rows=decoded?.result?.list;
      if(!Array.isArray(rows))throw new Error('HCMCloud decoded response has no result.list');
      const ids=rows.map(row=>String(row.id||'')),before=jobs.size;
      if(ids.some(id=>!id))throw new Error('HCMCloud list row has no stable ID');
      const normalized=[];let detailCursor=0;
      await Promise.all(Array.from({length:Math.min(cfg.detailConcurrency,rows.length)},async()=>{while(detailCursor<rows.length){
        const row=rows[detailCursor++],initial=normalize(row,source,response.record.response_file);
        if(initial.body_complete){normalized.push(initial);continue;}
        try{
          const detailPlain={id_:row.id,model:'ReleaseJobMgr',from_:'view'};
          const detailBody=strategy==='no'?detailPlain:encodePayload(detailPlain,strategy,keys);
          const detailResponse=await client.request({url:origin+'/api/hcm.model.get?model=ReleaseJobMgr',method:'POST',headers:{Accept:'application/json, text/plain, */*','Content-Type':'application/json;charset=utf-8',Origin:origin,Referer:source.primary_entry_url},body:detailBody},{purpose:'job_detail'});
          if(detailResponse.record.http_status!==200)throw new Error('HTTP '+detailResponse.record.http_status);
          const detailDecoded=strategy==='no'?detailResponse.data:decodePayload(detailResponse.data,strategy,keys);
          if(!detailDecoded?.result||typeof detailDecoded.result!=='object')throw new Error('decoded response has no result');
          normalized.push(normalize({...row,...detailDecoded.result},source,detailResponse.record.response_file));
        }catch{detailsFailed++;normalized.push(initial);}
      }}));
      for(const job of normalized)jobs.set(job.job_id,job);
      pages.push({page,job_ids:ids,new_ids:jobs.size-before,response_file:response.record.response_file});
      if(rows.length<cfg.pageSize){listComplete=true;reason='short_terminal_page';break;}
      if(jobs.size===before){reason='repeated_page_no_new_ids';break;}
    }
  }catch(error){errors.push(error.message);reason=error.message;}
  const status=listComplete&&!errors.length?'complete':jobs.size||pages.length?'partial':'failed';
  return {company_id:source.company_id,display_name:source.display_name,checked_at:new Date().toISOString(),jobs:[...jobs.values()],requests:client.records,
    ownership_evidence:{portal_company_name:companyName,contract_unit:source.api_config?.contract_unit??null},
    coverage:{status,pages:pages.length,server_total:null,jobs_observed:jobs.size,list_complete:listComplete,reason:errors.length?errors.join('; '):reason,
      details_failed:detailsFailed,page_evidence:pages,scope:'Public HCMCloud campus list and per-job hcm.model.get details; optional contract_unit filter preserved from official link'}};
}
