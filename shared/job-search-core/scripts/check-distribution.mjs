import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {CORE_ROOT,PACK_ROOT} from '../runtime-context.mjs';
import {publicCompanyRecords,publicCompatibility} from './lib/public-company-data.mjs';
import {DATA_FILES,OPTIONAL_DATA_FILES,validateDataSnapshot} from './lib/data-release-contract.mjs';
const listed=[...new Set(execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:PACK_ROOT,encoding:'utf8'}).split('\0').filter(Boolean))];
const files=[];for(const file of listed)if(await fs.stat(path.join(PACK_ROOT,file)).catch(()=>null))files.push(file);
const blocked=/^(datasets|docs)\/|(?:^|\/)(artifacts|runs|outputs|internal|logs)\/|^shared\/job-search-core\/evals\/|^shared\/job-search-core\/data\/(company-label-reviews\.json|company-research-candidates\.json\.gz|company-api-labels\.json\.gz|waiqi-foreign-company-index\.json)$|^shared\/job-search-core\/assets\/waiqi-(source-candidates|interface-catalog|interface-review-index)\.json$/;
const problems=files.filter(f=>blocked.test(f)||/^maintenance\/|(?:^|\/)state\//.test(f)).map(f=>'Private path included: '+f);
const privateCode=/(?:^|\/)(?:source-repair|repair-policy|source-discovery|source-candidates|company-maintenance|company-source-maintenance|company-source-publication|company-review-publication|company-publication-transaction|publish-company-data|refresh-cities|maintenance-paths)\.mjs$/;
for(const f of files)if(f.startsWith('recruitment-link-repair/')||privateCode.test(f))problems.push('Private implementation included: '+f);
const snapshot={};for(const rel of [...DATA_FILES,...OPTIONAL_DATA_FILES]){try{snapshot[rel]=JSON.parse(await fs.readFile(path.join(CORE_ROOT,rel),'utf8'));}catch(e){if(e.code==='ENOENT'&&OPTIONAL_DATA_FILES.includes(rel))continue;throw e;}}
try{validateDataSnapshot(snapshot);}catch(e){problems.push(e.message);}
for(const f of files.filter(f=>f.endsWith('.mjs')&&!f.includes('/tests/')&&!f.endsWith('check-distribution.mjs'))){const text=await fs.readFile(path.join(PACK_ROOT,f),'utf8');if(/\bmaintainSource\s*\(|\bcommitSourceRepair\s*\(|repairPolicy\s*[:=]|\bdiscoverRepairCandidates\s*\(/.test(text))problems.push('Public repair invocation: '+f);}
const forbidden=new Set(['source_record','research_candidates','structured_output','supplemental_research','raw_response','documents','searches','classification_history','prior_classification']);
function scan(value,location){if(typeof value==='string'&&/(?:\b[A-Z]:[\\/]|job-search\/artifacts\/|datasets\/)/i.test(value))problems.push('Local evidence path: '+location);if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){if(forbidden.has(key))problems.push('Private field: '+location+'.'+key);scan(item,location+'.'+key);}}
for(const [name,kind] of [['company-records','records'],['company-business-tags','business'],['company-ownership-tags','ownership'],['company-profiles','profiles'],['company-size-tags','size']]){
 const value=JSON.parse(await fs.readFile(path.join(CORE_ROOT,'data',name+'.json'),'utf8'));
 const projected=kind==='records'?publicCompanyRecords(value):publicCompatibility(kind,value);
 if(JSON.stringify(value)!==JSON.stringify(projected))problems.push('Public schema whitelist mismatch: '+name);
 scan(value,name);
}
if(problems.length){console.error([...new Set(problems)].slice(0,40).join('\n'));process.exitCode=1;}else console.log('Public distribution passed: formal labels retained; private paths, fields and research archives excluded.');
