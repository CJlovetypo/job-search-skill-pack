import path from 'node:path';
import fs from 'node:fs/promises';
import {PACK_ROOT} from './runtime-context.mjs';
export const RESEARCH_ROOT=path.join(PACK_ROOT,'datasets/company-research');
export const RAW_ROOT=path.join(RESEARCH_ROOT,'raw');
export const ARCHIVE_FILE=path.join(RESEARCH_ROOT,'candidates/company-research-candidates.json.gz');
export const REVIEWS_FILE=path.join(RESEARCH_ROOT,'reviews/company-label-reviews.json');
export const API_LABELS_FILE=path.join(RESEARCH_ROOT,'reviews/company-api-labels.json.gz');
export const DEMO_LABELS_FILE=path.join(RESEARCH_ROOT,'reviews/company-demo-labels.json.gz');
export const INTERNAL_RECORDS_FILE=path.join(RESEARCH_ROOT,'exports/company-records.json');
export async function assertMaintenanceInputs(){
 for(const name of ['company-business-tags','company-ownership-tags','company-profiles','company-size-tags'])try{await fs.access(path.join(RESEARCH_ROOT,'inputs',name+'.json'));}catch{throw Error('缺少本地维护输入，请先恢复 datasets/company-research/inputs；公开运行不需要这些资料。');}
}
const batches=new Set(['perplexity-static-20260923','search-providers-20260924','tavily-gaps-20260924','other-provider-gaps-20260924','company-api-rechecks-20260924']);
// Resolve historical evidence without rewriting original records or needing a junction.
export function resolveResearchRecord(record){
 let relative=String(record).replaceAll('\\','/');
 const parts=relative.split('/');
 if(parts[0]==='job-search'&&parts[1]==='artifacts'&&batches.has(parts[2]))relative='datasets/company-research/raw/'+parts.slice(2).join('/');
 const file=path.resolve(PACK_ROOT,relative);
 const allowed=[RESEARCH_ROOT,path.join(PACK_ROOT,'job-search/artifacts')];
 if(!allowed.some(root=>file.startsWith(root+path.sep)))throw Error('Research record outside local maintenance roots');
 return file;
}
