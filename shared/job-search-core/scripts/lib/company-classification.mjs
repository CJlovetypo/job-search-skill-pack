// Explicit maintenance only: local description analysis keeps Demo provenance.
import fs from 'node:fs/promises';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {CORE_ROOT} from '../../runtime-context.mjs';
import {DEMO_LABELS_FILE,INTERNAL_RECORDS_FILE} from '../../maintenance-paths.mjs';
import {BUSINESS_TAXONOMY,businessVocabulary,canonicalBusiness} from './business-taxonomy.mjs';
import {INDUSTRIES} from './industry-routing.mjs';
import {bytesHash} from './company-evidence.mjs';
import {loadCompanyInputs,buildCompanyRecords,indexById,projectCompanyRecords} from './company-records.mjs';
import {companyInputHashes,patchReviewedFields} from './company-review-publication.mjs';
import {publishPublicRecords} from './public-company-data.mjs';
import {withPublicationLock,committedPublication} from './company-publication-transaction.mjs';

const get=(o,k)=>k.split('.').reduce((v,p)=>v?.[p],o);
export const classificationInputHash=row=>bytesHash(JSON.stringify({identity:row.identity,summary:row.descriptions.business_summary,products:row.descriptions.products_services}));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function validateClassification(manifest,formal) {
  if(manifest.schema_version!==1||manifest.method!=='local_description_classification'||manifest.taxonomy_version!==BUSINESS_TAXONOMY.version||!manifest.batch_id||!manifest.reviewer)throw Error('Invalid classification manifest');
  if(!Array.isArray(manifest.companies)||manifest.companies.length!==formal.companies.length)throw Error('Every formal company needs a disposition');
  const rows=indexById(formal),seen=new Set(),vocabulary=businessVocabulary(),industries=new Set(INDUSTRIES.map(x=>x.id));
  const changes=[];
  for(const item of manifest.companies){
    const row=rows.get(item.company_id);
    if(!row||seen.has(item.company_id))throw Error('Unknown/duplicate classification company');seen.add(item.company_id);
    if(!['change','keep','insufficient','conflict','protected'].includes(item.disposition)||!item.reason||classificationInputHash(row)!==item.input_sha256)throw Error('Classification input or disposition changed: '+item.company_id);
    for(const [field,decision] of Object.entries(item.decisions||{})){
      if(!['tags.business','tags.industry'].includes(field)||item.disposition!=='change')throw Error('Classification may only change approved tags');
      const old=get(row,field),meta=row.governance.fields[field],allowed=field==='tags.business'?vocabulary:industries;
      if(meta.status==='verified'&&meta.origin==='fresh_web_review')throw Error('Classification cannot overwrite independent review');
      if(!same(old,decision.before)||!Array.isArray(decision.value)||!decision.value.length||new Set(decision.value).size!==decision.value.length||decision.value.some(v=>!allowed.has(v)))throw Error('Invalid classification values: '+item.company_id);
      if(!decision.reason||!['semantic','alias'].includes(decision.kind))throw Error('Classification needs a reason and method');
      if(decision.kind==='alias'){
        if(field!=='tags.business'||!same([...new Set(old.map(t=>canonicalBusiness(t)||t))],decision.value))throw Error('Alias migration changed meaning');
      }else{
        if(!Array.isArray(decision.citations)||!decision.citations.length)throw Error('Semantic classification needs source excerpts');
        for(const citation of decision.citations)if(!['descriptions.business_summary','descriptions.products_services'].includes(citation.field)||!citation.excerpt||!get(row,citation.field).includes(citation.excerpt))throw Error('Classification citation does not match formal source');
      }
      if(same(old,decision.value))throw Error('No-op classification change');
      changes.push({company_id:row.company_id,field,...decision});
    }
    if(item.disposition==='change'&&!Object.keys(item.decisions||{}).length)throw Error('Change disposition has no decisions');
  }
  return changes;
}

export async function publishClassification(file,{publish=false}={}){
 return withPublicationLock(async()=>{
  const bytes=await fs.readFile(path.resolve(file)),manifest=JSON.parse(bytes),planHash=bytesHash(bytes);
  if(publish){const receipt=await committedPublication(planHash);if(receipt)return receipt;}
  const hashes=await companyInputHashes();hashes[path.resolve(file)]=planHash;
  const taxonomyFile=path.join(CORE_ROOT,'data/business-taxonomy.json');
  if(manifest.taxonomy_sha256!==bytesHash(await fs.readFile(taxonomyFile)))throw Error('Classification taxonomy changed');
  const formalFile=path.join(CORE_ROOT,'data/company-records.json'),formalBytes=await fs.readFile(formalFile),formal=JSON.parse(formalBytes);
  if(manifest.baseline_sha256!==bytesHash(formalBytes))throw Error('Formal baseline changed; regenerate classification preview');
  const changes=validateClassification(manifest,formal),now=new Date().toISOString();
  const summary={batch_id:manifest.batch_id,companies:manifest.companies.length,changed_companies:new Set(changes.map(x=>x.company_id)).size,changed_fields:changes.length,
    business_fields:changes.filter(x=>x.field==='tags.business').length,industry_fields:changes.filter(x=>x.field==='tags.industry').length,
    dispositions:Object.fromEntries(['change','keep','insufficient','conflict','protected'].map(k=>[k,manifest.companies.filter(x=>x.disposition===k).length])),status:'demo_unreviewed',published:false};
  if(!publish)return summary;
  const inputs=await loadCompanyInputs({includeResearch:false}),labels=structuredClone(inputs.demoLabels),byId=indexById(labels),current=indexById(formal),selections=[];
  for(const change of changes){
    const row=current.get(change.company_id);let demo=byId.get(change.company_id);
    if(!demo){demo={company_id:change.company_id,display_name:row.identity.display_name,decisions:{}};labels.companies.push(demo);byId.set(change.company_id,demo);}
    demo.decisions[change.field]={status:'demo_unreviewed',value:change.value,entity:row.identity.display_name,checked_at:now,reason:change.reason,
      evidence:[],provider:'local_codex_analysis',demo_batch:manifest.batch_id,method:manifest.method,taxonomy_version:manifest.taxonomy_version,
      source_record:path.resolve(file),citations:change.citations||[],input_sha256:classificationInputHash(row),data_availability:'local_description_classification'};
    selections.push({company_id:change.company_id,fields:[change.field]});
  }
  labels.updated_at=now;
  const generated=buildCompanyRecords({...inputs,demoLabels:labels},{now});
  const records=patchReviewedFields(formal,generated,selections).records;
  const internal=patchReviewedFields(JSON.parse(await fs.readFile(INTERNAL_RECORDS_FILE,'utf8')),generated,selections).records;
  await publishPublicRecords(records,projectCompanyRecords(records,inputs),{inputs:hashes,extraWrites:[
    {file:DEMO_LABELS_FILE,bytes:gzipSync(JSON.stringify(labels)+'\n')},{file:INTERNAL_RECORDS_FILE,bytes:JSON.stringify(internal)+'\n'}],
    metadata:{kind:manifest.method,plan_hash:planHash,batch_id:manifest.batch_id,summary}});
  return {...summary,published:true,plan_hash:planHash};
 });
}
