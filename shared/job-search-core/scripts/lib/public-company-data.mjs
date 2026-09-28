const pick=(row,keys)=>Object.fromEntries(keys.filter(k=>row?.[k]!==undefined).map(k=>[k,structuredClone(row[k])]));
export function publicUrl(value){
 try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||/localhost|127\.0\.0\.1/.test(u.hostname))return null;
 if([...u.searchParams.keys()].some(k=>/token|secret|signature|credential|session|api.?key/i.test(k)))return null;
 if(/(?:notion\.(?:so|com)|kdocs\.cn)$/.test(u.hostname)||/(?:feishu\.cn|larksuite\.com)$/.test(u.hostname)&&/^\/(docx?|wiki|base|sheets)\//i.test(u.pathname))return null;
 return u.href;}catch{return null;}
}
export function publicEvidence(items=[]){return items.flatMap(item=>{const url=publicUrl(item.url);return url?[{url,...pick(item,['title','checked_at','provider','evidence_type']),note:'公开来源索引；完整研究证据保存在维护数据集。'}]:[];});}
function fieldMetadata(row={}){
 const result=pick(row,['status','entity','as_of','checked_at','origin','review_state','provider','providers','model_version','dependencies']);
 result.reason=row.status==='api_supported'?'API 有公开来源支持，尚未独立核实。':row.status==='demo_unreviewed'?'首版正式画像值，已可供 Skill 使用，尚未独立复核。':row.origin==='fresh_web_review'?'维护流程已独立复核；状态以字段结论为准。':'沿用既有字段结论；来源状态未升级。';
 result.evidence=publicEvidence(row.evidence);return result;
}
export function publicCompanyRecords(records){
 return {schema_version:records.schema_version,generated_at:records.generated_at,publication_format:1,companies:records.companies.map(row=>({
  company_id:row.company_id,identity:pick(row.identity,['company_id','display_name','aliases']),
  tags:{...pick(row.tags,['industry','business','ownership','organization_size','headquarters_country','listing_status']),recruitment:Object.fromEntries(Object.entries(row.tags.recruitment||{}).filter(([mode])=>['campus','internship','social'].includes(mode)).map(([mode,value])=>[mode,{cities:(value.cities||[]).filter(x=>typeof x==='string')}]))},
  descriptions:pick(row.descriptions,['business_summary','products_services','customers','business_regions','workforce','capital','entity_relationships']),
  sources:(row.sources||[]).map(s=>({...pick(s,['source_id','provider']),url:publicUrl(s.url)})),
  governance:{fields:Object.fromEntries(Object.entries(row.governance.fields).map(([key,value])=>[key,fieldMetadata(value)])),
   recruitment:Object.fromEntries(Object.entries(row.governance.recruitment||{}).map(([mode,value])=>[mode,pick(value,['status','origin','review_state','updated_at','last_refresh_at','last_refresh_status','city_coverage_complete','source_config_fingerprint'])]))}
 }))};
}
export function assertIndependentReviewsUnchanged(previous,data) {
 const old=new Map((previous?.companies||[]).map(c=>[c.company_id,c])),next=new Map(data.companies.map(c=>[c.company_id,c]));
 for(const id of new Set([...old.keys(),...next.keys()])) {
  const prior=old.get(id),row=next.get(id),fields=new Set([...Object.keys(prior?.governance.fields||{}),...Object.keys(row?.governance.fields||{})]);
  for(const field of fields)if(prior?.governance.fields[field]?.origin==='fresh_web_review'&&prior.governance.fields[field].status==='verified'||!prior?.governance.fields[field]&&row?.governance.fields[field]?.origin==='fresh_web_review') {
   const get=r=>field.split('.').reduce((v,k)=>v?.[k],r);
   if(JSON.stringify(get(row))!==JSON.stringify(get(prior))||JSON.stringify(row?.governance.fields[field])!==JSON.stringify(prior?.governance.fields[field]))throw Error('Independent review change must use approved field publication: '+id+' '+field);
  }
 }
}
export function publicCompatibility(kind,data){
 const headers=pick(data,['schema_version','updated_at','model','counts']);
 const common=['company_id','display_name'];
 const rows=(data.companies||[]).map(row=>{
  if(kind==='profiles'){const result=pick(row,common);for(const field of ['business','workforce','capital'])if(row[field])result[field]={...pick(row[field],['value','status','entity','as_of','checked_at']),evidence:publicEvidence(row[field].evidence)};return result;}
  const keys=kind==='business'?['business_tags','business_summary','status']:kind==='ownership'?['ownership_tag','status','checked_at']:['model_version','checked_at','ownership_tag','label','status','entity','as_of','scope','confidence','range'];
  return {...pick(row,[...common,...keys]),reason:'既有正式数据；详细维护记录保存在本地。',evidence:publicEvidence(row.evidence)};
 });return {...headers,companies:rows};
}
