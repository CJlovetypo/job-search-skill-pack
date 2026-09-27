const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export function assertAutomaticRepair(old,next,{identity,result,mode,kind}={}){
 if(!identity?.accepted||old.identity_verification?.identity_verified===false)throw Error('automatic_repair_identity_not_verified');
 if(!['moka','feishu'].includes(old.provider)||next.provider!==old.provider)throw Error('automatic_repair_platform_requires_maintenance');
 if(!['campus','internship','social'].includes(mode))throw Error('automatic_repair_direction_required');
 const target=mode==='campus'?'formal':mode;
 if(!(result?.jobs||[]).some(j=>j.body_complete&&j.job_id&&j.official_url&&j.formal_status===target&&j.open_status==='open'))throw Error('automatic_repair_requires_current_target_full_jd');
 if(!result.coverage?.pages||result.coverage.status==='failed')throw Error('automatic_repair_requires_list_evidence');
 if(!['public_redirect','public_current_configuration','public_website_path_rotation'].includes(kind))throw Error('automatic_repair_project_binding_required');
 const before=new URL(old.primary_entry_url),after=new URL(next.primary_entry_url);
 if(before.origin!==after.origin||after.username||after.password||after.protocol!=='https:')throw Error('automatic_repair_origin_changed');
 if(before.search!==after.search||before.hash!==after.hash||old.provider==='feishu'&&before.pathname!==after.pathname)throw Error('automatic_repair_entry_scope_changed');
 const allowed=new Set(['primary_entry_url','validated_api_request_examples','public_bootstrap_requests']);
 for(const key of new Set([...Object.keys(old),...Object.keys(next)]))if(!allowed.has(key)&&!same(old[key],next[key]))throw Error('automatic_repair_field_denied: '+key);
 const prior=old.validated_api_request_examples||[],requests=next.validated_api_request_examples||[];
 if(!prior.length||requests.length!==prior.length)throw Error('automatic_repair_request_shape_changed');
 let siteId;
 if(old.provider==='moka'){
  const a=before.pathname.match(/^\/(campus-recruitment|social-recruitment)\/([^/]+)\/([^/]+)/),b=after.pathname.match(/^\/(campus-recruitment|social-recruitment)\/([^/]+)\/([^/]+)/);
  if(!a||!b||a[1]!==b[1]||a[2]!==b[2])throw Error('automatic_repair_tenant_or_channel_changed');
  siteId=b[3];
 }
 for(let i=0;i<prior.length;i++){
  const a=prior[i],b=requests[i],copy=structuredClone(b),u=new URL(a.url),v=new URL(b.url);
  if(u.href!==v.href||v.username||v.password)throw Error('automatic_repair_api_route_changed');
  copy.url=a.url;
  const headers={...b.headers};
  for(const key of ['Origin','Referer','website-path']){
   if(key==='website-path'&&old.provider!=='feishu'){if(!same(a.headers?.[key],b.headers?.[key]))throw Error('automatic_repair_header_denied');continue;}
   if(key==='Origin'&&b.headers?.[key]!==undefined&&b.headers[key]!==after.origin||key==='Referer'&&b.headers?.[key]!==undefined&&b.headers[key]!==next.primary_entry_url)throw Error('automatic_repair_header_mismatch');
   if(key==='website-path'&&(!b.headers?.[key]||typeof b.headers[key]!=='string'))throw Error('automatic_repair_website_path_required');
   if(a.headers?.[key]===undefined)delete headers[key];else headers[key]=a.headers[key];
  }
  copy.headers=headers;
  if(!a.headers&&Object.keys(headers).length===0)delete copy.headers;
  if(old.provider==='moka'&&/\/website\/jobs\/v2/.test(u.pathname)){
   if(typeof a.body!=='object'||typeof b.body!=='object'||String(b.body.siteId)!==siteId)throw Error('automatic_repair_site_id_mismatch');
   copy.body={...b.body,siteId:a.body.siteId};
  }
  if(!same(copy,a))throw Error('automatic_repair_request_field_denied');
 }
 const boots=next.public_bootstrap_requests;
 if(!Array.isArray(boots)||boots.length!==1||!same(boots[0],{url:next.primary_entry_url,method:'GET',purpose:'public_configuration_bootstrap'}))throw Error('automatic_repair_bootstrap_denied');
 return true;
}
