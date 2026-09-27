import fs from 'node:fs/promises';
import path from 'node:path';
import {CORE_ROOT} from '../runtime-context.mjs';
// Exact historical evidence compatibility exceptions; none imports product code.
const history=new Set(['maintenance-paths.mjs','scripts/archive-company-research.mjs','scripts/lib/company-evidence.mjs','scripts/lib/company-review-calibration.mjs']);
const messages=new Set(['cli.mjs','launcher.mjs','scripts/lib/task-decision.mjs']);
const problems=[];
async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){
 if(['state','node_modules','.local','data','assets','references'].includes(entry.name))continue;
 const file=path.join(dir,entry.name);if(entry.isDirectory()){await walk(file);continue;}if(!/\.(mjs|py)$/.test(file)||file===new URL(import.meta.url).pathname)continue;
 const relative=path.relative(CORE_ROOT,file).replaceAll('\\','/'),text=await fs.readFile(file,'utf8');if(relative==='scripts/check-boundaries.mjs')continue;
 for(const match of text.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)){
  if(match[1].startsWith('.')&&!path.resolve(path.dirname(file),match[1]).startsWith(CORE_ROOT+path.sep))problems.push(relative+': shared import leaves core: '+match[1]);
 }
 if(!history.has(relative)&&!messages.has(relative)&&/job-search[/'"]|job-radar[/'"]|recruitment-link-repair[/'"]/.test(text))problems.push(relative+': product runtime path or subprocess dependency');
}}
await walk(CORE_ROOT);
if(problems.length){console.error(problems.join('\n'));process.exitCode=1;}else console.log('Shared dependency boundaries passed; only documented historical evidence mappings remain.');
