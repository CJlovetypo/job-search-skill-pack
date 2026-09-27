import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const root=path.resolve(process.argv[2]||'shared/job-search-core/state/maintenance/waiqi-2026-09-20');
const read=async file=>JSON.parse(await fs.readFile(path.join(root,file),'utf8'));
const listFiles=async dir=>(await fs.readdir(path.join(root,dir))).filter(x=>x.endsWith('.json')).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
const walk=async dir=>{const base=path.join(root,dir);try{const out=[];for(const entry of await fs.readdir(base,{withFileTypes:true})){const relative=path.join(dir,entry.name);if(entry.isDirectory())out.push(...await walk(relative));else out.push(relative);}return out.sort();}catch(error){if(error.code==='ENOENT')return [];throw error;}};
const sha256=async file=>{const data=await fs.readFile(path.join(root,file));return {path:file.replaceAll('\\','/'),bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};};
const keys=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value):[];
const union=(set,value)=>{for(const key of keys(value))set.add(key);};

const companyList=await read('company-list.json');
const catalog=companyList.companies||[];
const catalogIds=new Set(catalog.map(x=>String(x.id)));
const pageFiles=await listFiles('lists');
const companyFiles=await listFiles('companies');
const positionFiles=await listFiles('positions');
const detailFiles=await listFiles('job-details').catch(()=>[]);
const issues=[];
const add=(code,detail)=>issues.push({code,detail});

if(companyList.reported_total!==catalog.length)add('catalog_total_mismatch',{reported:companyList.reported_total,actual:catalog.length});
if(catalogIds.size!==catalog.length)add('catalog_duplicate_company_ids',{rows:catalog.length,unique:catalogIds.size});
const expectedPages=Math.ceil((companyList.reported_total||0)/100);
if(pageFiles.length!==expectedPages)add('list_page_count_mismatch',{expected:expectedPages,actual:pageFiles.length});

const listSeen=new Set(),listFieldNames=new Set(),companyFieldNames=new Set(),positionFieldNames=new Set(),detailFieldNames=new Set();
for(const file of pageFiles){
  const response=await read(path.join('lists',file));
  if(!response.success)add('list_page_failed',{file,error:response.error});
  for(const row of response.data?.page?.records||[]){listSeen.add(String(row.id));union(listFieldNames,row);}
}
for(const id of catalogIds)if(!listSeen.has(id))add('catalog_id_missing_from_pages',{id});
for(const id of listSeen)if(!catalogIds.has(id))add('page_id_missing_from_catalog',{id});

const companyFileIds=new Set(companyFiles.map(x=>path.basename(x,'.json')));
const positionFileIds=new Set(positionFiles.map(x=>path.basename(x,'.json')));
const historicalCompanyFileIds=[...companyFileIds].filter(id=>!catalogIds.has(id));
const historicalPositionFileIds=[...positionFileIds].filter(id=>!catalogIds.has(id));
for(const id of catalogIds){
  if(!companyFileIds.has(id))add('company_detail_file_missing',{id});
  if(!positionFileIds.has(id))add('position_list_file_missing',{id});
}

let companyDetailsOk=0,positionListsOk=0,positionRows=0,emptyPositionLists=0;
const positionKeys=new Map(),positionIds=new Set(),positionCountDiscrepancies=[];
for(const row of catalog){
  const id=String(row.id);
  if(companyFileIds.has(id)){
    const response=await read(path.join('companies',`${id}.json`));
    if(response.success){companyDetailsOk++;union(companyFieldNames,response.data);if(String(response.data?.id)!==id)add('company_detail_identity_mismatch',{id,returned_id:response.data?.id});}
    else add('company_detail_failed',{id,error:response.error});
  }
  if(positionFileIds.has(id)){
    const response=await read(path.join('positions',`${id}.json`));
    if(!response.success){add('position_list_failed',{id,error:response.error});continue;}
    positionListsOk++;
    const rows=Array.isArray(response.data)?response.data:[];
    if(!Array.isArray(response.data))add('position_list_not_array',{id});
    if(rows.length===0)emptyPositionLists++;
    if(Number.isFinite(Number(row.positionCount))&&Number(row.positionCount)!==rows.length)positionCountDiscrepancies.push({id:Number(id),reported:Number(row.positionCount),returned:rows.length});
    positionRows+=rows.length;
    for(const job of rows){
      union(positionFieldNames,job);
      const jobId=String(job.id),key=`${Number(job.posType||1)}-${jobId}`;
      positionIds.add(jobId);
      const owners=positionKeys.get(key)||new Set();owners.add(id);positionKeys.set(key,owners);
    }
  }
}
const duplicatePositionKeys=[...positionKeys].filter(([,owners])=>owners.size>1).map(([key,owners])=>({key,company_ids:[...owners]}));

let jobDetailsOk=0,jobDetailsFailed=0,orphanDetails=0;
for(const file of detailFiles){
  const response=await read(path.join('job-details',file));
  if(!response.success){jobDetailsFailed++;continue;}
  jobDetailsOk++;union(detailFieldNames,response.data);
  const id=String(response.data?.id??'');
  if(!positionIds.has(id))orphanDetails++;
}

const coreFiles=[
  'company-list.json','companies.csv','recruitment-links.csv','jobs.jsonl','summary.json','crawl-summary.json',
  ...pageFiles.map(x=>path.join('lists',x)),...companyFiles.map(x=>path.join('companies',x)),
  ...positionFiles.map(x=>path.join('positions',x))
  ,...await walk('frontend'),...await walk('frontend-current'),...await walk('reference-data')
];
const existing=[];
for(const file of coreFiles){try{await fs.access(path.join(root,file));existing.push(file);}catch{}}
const manifest=[];
for(let i=0;i<existing.length;i+=64)manifest.push(...await Promise.all(existing.slice(i,i+64).map(sha256)));
const aggregate=createHash('sha256');
for(const item of manifest)aggregate.update(`${item.sha256}  ${item.path}\n`);

const generatedAt=new Date().toISOString();
const audit={
  schema_version:1,generated_at:generatedAt,archive_root:root,
  verdict:issues.length?'incomplete':'complete',
  coverage:{reported_companies:companyList.reported_total,catalog_companies:catalog.length,list_pages:pageFiles.length,list_unique_companies:listSeen.size,company_details_ok:companyDetailsOk,position_lists_ok:positionListsOk,position_rows:positionRows,unique_position_keys:positionKeys.size,empty_position_lists:emptyPositionLists,job_details_ok:jobDetailsOk,job_details_failed:jobDetailsFailed,job_details_orphaned:orphanDetails},
  observations:{position_count_discrepancies:positionCountDiscrepancies.length,position_keys_shared_by_companies:duplicatePositionKeys.length,historical_company_files:historicalCompanyFileIds,historical_position_files:historicalPositionFileIds,job_detail_files_are_historical_and_excluded_from_completeness:true},
  schemas:{company_list_fields:[...listFieldNames].sort(),company_detail_fields:[...companyFieldNames].sort(),position_list_fields:[...positionFieldNames].sort(),job_detail_fields:[...detailFieldNames].sort()},
  issues,
  shared_position_keys:duplicatePositionKeys,
  position_count_discrepancies:positionCountDiscrepancies
};
const assetManifest={schema_version:1,generated_at:generatedAt,archive_root:root,file_count:manifest.length,total_bytes:manifest.reduce((n,x)=>n+x.bytes,0),aggregate_sha256:aggregate.digest('hex'),files:manifest};
await fs.writeFile(path.join(root,'traversal-audit.json'),JSON.stringify(audit,null,2)+'\n');
await fs.writeFile(path.join(root,'asset-manifest.json'),JSON.stringify(assetManifest,null,2)+'\n');
console.log(JSON.stringify({audit:path.join(root,'traversal-audit.json'),manifest:path.join(root,'asset-manifest.json'),verdict:audit.verdict,coverage:audit.coverage,observations:audit.observations,issues:issues.length,asset_files:assetManifest.file_count,asset_bytes:assetManifest.total_bytes,aggregate_sha256:assetManifest.aggregate_sha256},null,2));
if(issues.length)process.exitCode=2;
