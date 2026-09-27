import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {CORE_ROOT,PACK_ROOT} from '../runtime-context.mjs';
import {publicCompanyRecords,publicCompatibility} from './lib/public-company-data.mjs';
const files=[...new Set(execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:PACK_ROOT,encoding:'utf8'}).split('\0').filter(Boolean))];
const blocked=/^(datasets|docs)\/|(?:^|\/)(artifacts|runs|outputs|internal|logs)\/|^shared\/job-search-core\/evals\/|^shared\/job-search-core\/data\/(company-label-reviews\.json|company-research-candidates\.json\.gz|company-api-labels\.json\.gz|waiqi-foreign-company-index\.json)$|^shared\/job-search-core\/assets\/waiqi-(source-candidates|interface-catalog|interface-review-index)\.json$/;
const problems=files.filter(f=>blocked.test(f)||/^maintenance\/|(?:^|\/)state\//.test(f)).map(f=>'Private path included: '+f);
const forbidden=new Set(['source_record','research_candidates','structured_output','supplemental_research','raw_response','documents','searches','classification_history','prior_classification']);
function scan(value,location){if(typeof value==='string'&&/(?:\b[A-Z]:[\\/]|job-search\/artifacts\/|datasets\/)/i.test(value))problems.push('Local evidence path: '+location);if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){if(forbidden.has(key))problems.push('Private field: '+location+'.'+key);scan(item,location+'.'+key);}}
for(const [name,kind] of [['company-records','records'],['company-business-tags','business'],['company-ownership-tags','ownership'],['company-profiles','profiles'],['company-size-tags','size']]){
 const value=JSON.parse(await fs.readFile(path.join(CORE_ROOT,'data',name+'.json'),'utf8'));
 const projected=kind==='records'?publicCompanyRecords(value):publicCompatibility(kind,value);
 if(JSON.stringify(value)!==JSON.stringify(projected))problems.push('Public schema whitelist mismatch: '+name);
 scan(value,name);
}
const sources=JSON.parse(await fs.readFile(path.join(CORE_ROOT,'assets/sources.json'),'utf8'));
const repairFields=new Set(['repair_id','checked_at','kind','previous_fingerprint','current_fingerprint','scope','validation','evidence_urls']);
for(const c of sources.companies)for(const s of [c,...c.recruitment_sources||[]])for(const h of s.repair_history||[]){
 for(const key of Object.keys(h))if(!repairFields.has(key))problems.push('Private repair field: '+c.company_id+'.'+key);
 scan(h,'repair_history.'+c.company_id);
}
if(problems.length){console.error([...new Set(problems)].slice(0,40).join('\n'));process.exitCode=1;}else console.log('Public distribution passed: formal labels retained; private paths, fields and research archives excluded.');
