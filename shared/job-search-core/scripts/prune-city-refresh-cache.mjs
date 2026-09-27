import fs from 'node:fs/promises';
import path from 'node:path';
import {PACK_ROOT, MODE_ROOTS} from '../runtime-context.mjs';

const modes=process.argv.slice(2);
if(!modes.length||modes.some(mode=>!MODE_ROOTS[mode]))throw Error('Usage: node prune-city-refresh-cache.mjs campus internship social');

let removed=0;
for(const mode of modes){
  const root=path.resolve(PACK_ROOT,'shared/job-search-core/state/city-refresh',mode);
  const relative=path.relative(PACK_ROOT,root);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw Error(`Unsafe artifact root: ${root}`);
  let entries=[];
  try{entries=await fs.readdir(root,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
  for(const entry of entries){
    if(!entry.isDirectory()||entry.isSymbolicLink())continue;
    const target=path.resolve(root,entry.name,'http');
    if(path.dirname(path.dirname(target))!==root||path.basename(target)!=='http')throw Error(`Unsafe cache target: ${target}`);
    try{const stat=await fs.lstat(target);if(stat.isSymbolicLink()||!stat.isDirectory())continue;}catch(error){if(error.code==='ENOENT')continue;throw error;}
    await fs.rm(target,{recursive:true,force:false});
    removed++;
  }
}
console.log(JSON.stringify({modes,removed_http_directories:removed}));
