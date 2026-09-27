import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {RESEARCH_ROOT} from '../../maintenance-paths.mjs';
import {bytesHash} from './company-evidence.mjs';

const context=new AsyncLocalStorage();
export const PUBLICATION_ROOT=path.join(RESEARCH_ROOT,'publications');
const read=async f=>{try{return await fs.readFile(f);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const digest=bytes=>bytes===null?null:bytesHash(bytes);
const json=async f=>JSON.parse(await fs.readFile(f,'utf8'));
async function atomicWrite(file,bytes) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temp,bytes,{flush:true});await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
const save=(f,x)=>atomicWrite(f,JSON.stringify(x,null,2)+'\n');

export async function withPublicationLock(fn,{root=PUBLICATION_ROOT,recovery=false}={}) {
  root=path.resolve(root);
  const existing=context.getStore();
  if(existing?.root===root)return fn(existing);
  await fs.mkdir(root,{recursive:true});
  const lockFile=path.join(root,'writer.lock');let handle;
  try{handle=await fs.open(lockFile,'wx');}catch(e){if(e.code==='EEXIST')throw Error('Company publication is locked; inspect writer.lock before recovery');throw e;}
  const token={root,id:randomUUID()};
  try {
    await handle.writeFile(JSON.stringify({pid:process.pid,id:token.id,started_at:new Date().toISOString()})+'\n');await handle.sync();
    if(!recovery&&await read(path.join(root,'pending.json')))throw Error('An interrupted company publication requires recover before new writes');
    return await context.run(token,()=>fn(token));
  } finally {await handle.close();await fs.unlink(lockFile);}
}

// Stage every output and backup before touching a target. A pending journal is
// retained on failure; recovery only proceeds from known before/after hashes.
export async function commitPublication(writes,{root=PUBLICATION_ROOT,inputs={},metadata={},faultAfter=null}={}) {
  return withPublicationLock(async()=>{
    if(await read(path.join(root,'pending.json')))throw Error('An interrupted publication requires recovery before another commit');
    if(!writes.length)throw Error('Empty publication');
    const targets=writes.map(w=>path.resolve(w.file));
    if(new Set(targets).size!==targets.length)throw Error('Duplicate publication target');
    for(const [file,hash]of Object.entries(inputs))if(digest(await read(file))!==hash)throw Error('Publication input changed: '+file);
    const id=randomUUID(),dir=path.join(root,id);await fs.mkdir(dir,{recursive:true});
    const entries=[];
    for(let i=0;i<writes.length;i++) {
      const file=targets[i],old=await read(file),next=Buffer.isBuffer(writes[i].bytes)?writes[i].bytes:Buffer.from(writes[i].bytes);
      const before=digest(old),after=digest(next);
      if(Object.hasOwn(writes[i],'expected')&&writes[i].expected!==before)throw Error('Publication target changed: '+file);
      const backup=path.join(dir,i+'.before'),staged=path.join(dir,i+'.after');
      if(old!==null)await fs.writeFile(backup,old,{flush:true});await fs.writeFile(staged,next,{flush:true});
      entries.push({file,before,after,backup,staged});
    }
    const journal={schema_version:1,id,created_at:new Date().toISOString(),status:'prepared',metadata,inputs,entries};
    const journalFile=path.join(dir,'journal.json');await save(journalFile,journal);
    await save(path.join(root,'pending.json'),{id,journal:journalFile});
    // No producer can acquire this lock while a recoverable publication is pending.
    for(const [file,hash]of Object.entries(inputs))if(digest(await read(file))!==hash)throw Error('Publication input changed after staging: '+file);
    for(const e of entries)if(digest(await read(e.file))!==e.before)throw Error('Publication target changed after staging: '+e.file);
    journal.status='applying';await save(journalFile,journal);
    for(let i=0;i<entries.length;i++) {
      const e=entries[i];
      if(digest(await read(e.file))!==e.before)throw Error('Concurrent target edit: '+e.file);
      await atomicWrite(e.file,await fs.readFile(e.staged));
      if(faultAfter===i+1)throw Error('Injected publication interruption');
    }
    for(const e of entries)if(digest(await read(e.file))!==e.after)throw Error('Publication readback mismatch: '+e.file);
    journal.status='committed';journal.committed_at=new Date().toISOString();await save(journalFile,journal);
    await fs.unlink(path.join(root,'pending.json'));
    return {id,journal:journalFile,status:'committed',files:entries.length,readback_verified:true};
  },{root});
}

export async function recoverPublication({root=PUBLICATION_ROOT,allowedTargets,rollback=false}={}) {
  return withPublicationLock(async()=>{
    const pointer=await json(path.join(root,'pending.json'));
    if(!/^[a-f0-9-]{36}$/.test(pointer.id)||path.resolve(pointer.journal)!==path.resolve(root,pointer.id,'journal.json'))throw Error('Invalid recovery pointer');
    const j=await json(pointer.journal),allowed=new Set(allowedTargets?.map(f=>path.resolve(f))||[]);
    if(!allowed.size||j.entries.some(e=>!allowed.has(path.resolve(e.file))))throw Error('Recovery target outside approved company files');
    for(let i=0;i<j.entries.length;i++) {
      const e=j.entries[i];
      if(path.resolve(e.staged)!==path.resolve(root,pointer.id,i+'.after')||path.resolve(e.backup)!==path.resolve(root,pointer.id,i+'.before'))throw Error('Recovery archive path changed');
      if(digest(await read(e.staged))!==e.after||(e.before!==null&&digest(await read(e.backup))!==e.before))throw Error('Recovery archive corrupted');
      const current=digest(await read(e.file));
      if(current!==e.before&&current!==e.after)throw Error('Recovery refuses concurrent target changes: '+e.file);
    }
    // Unchanged external inputs must still match; changed sources require a fresh
    // preview instead of silently finishing a stale calculation.
    const targets=new Set(j.entries.map(e=>e.file));
    if(!rollback)for(const [file,hash]of Object.entries(j.inputs||{}))if(!targets.has(file)&&digest(await read(file))!==hash)throw Error('Recovery input changed; use rollback then prepare a new preview: '+file);
    for(const e of rollback?[...j.entries].reverse():j.entries) {
      const current=digest(await read(e.file)),desired=rollback?e.before:e.after;
      if(current!==e.before&&current!==e.after)throw Error('Concurrent recovery target edit: '+e.file);
      if(current!==desired) {
        if(desired===null)await fs.unlink(e.file);
        else await atomicWrite(e.file,await fs.readFile(rollback?e.backup:e.staged));
      }
    }
    for(const e of j.entries)if(digest(await read(e.file))!==(rollback?e.before:e.after))throw Error('Recovery readback mismatch');
    j.status=rollback?'rolled_back':'committed';j.recovered_at=new Date().toISOString();await save(pointer.journal,j);await fs.unlink(path.join(root,'pending.json'));
    return {id:j.id,journal:pointer.journal,status:j.status,recovered:true,readback_verified:true};
  },{root,recovery:true});
}

// Also recovers the receipt if a process stopped after committing the data.
export async function committedPublication(planHash,{root=PUBLICATION_ROOT}={}) {
  for(const name of await fs.readdir(root).catch(e=>{if(e.code==='ENOENT')return [];throw e;})) {
    if(!/^[a-f0-9-]{36}$/.test(name))continue;
    const file=path.join(root,name,'journal.json'),bytes=await read(file);if(!bytes)continue;
    const journal=JSON.parse(bytes);
    if(journal.status!=='committed'||journal.metadata?.plan_hash!==planHash)continue;
    for(const e of journal.entries)if(digest(await read(e.file))!==e.after)throw Error('This plan was already published; formal data has since changed. Do not replay it.');
    return {id:journal.id,journal:file,status:'committed',files:journal.entries.length,readback_verified:true,already_published:true};
  }
  return null;
}

export async function clearAbandonedPublicationLock({root=PUBLICATION_ROOT}={}) {
  const file=path.join(root,'writer.lock'),lock=await json(file);
  if(!Number.isInteger(lock.pid)||lock.pid<1)throw Error('Invalid lock owner; inspect manually');
  try{process.kill(lock.pid,0);throw Error('Publication lock owner is still running');}catch(e){if(e.code!=='ESRCH')throw e;}
  // Exact bytes prevent clearing a different owner's lock after inspection.
  if((await json(file)).id!==lock.id)throw Error('Lock owner changed');await fs.unlink(file);
  return {cleared:true,owner:lock.pid};
}
