import fs from 'node:fs/promises';
import path from 'node:path';
import {runtimeRoot as SKILL_ROOT} from '../../runtime-context.mjs';
import {randomUUID} from 'node:crypto';
export {SKILL_ROOT};
const resolveDataset=p=>path.resolve(p);
export async function readJson(p,fallback) {try{return JSON.parse(await fs.readFile(resolveDataset(p),'utf8'));}catch(e){if(e.code==='ENOENT'&&fallback!==undefined)return fallback;throw e;}}
export async function writeJson(p,value) {p=resolveDataset(p);await fs.mkdir(path.dirname(p),{recursive:true});const tmp=p+'.'+randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n','utf8');await fs.rename(tmp,p);}
export function workspacePath(p) {const full=path.resolve(p);const rel=path.relative(SKILL_ROOT,full);if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('输出必须位于本 skill 文件夹内：'+full);return full;}
export async function mapLimit(items,limit,fn) {let next=0;const results=new Array(items.length);await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;results[i]=await fn(items[i],i);}}));return results;}
export function stamp() {return new Date().toISOString().replace(/[:.]/g,'-');}
export function relative(p) {return path.relative(SKILL_ROOT,p).split(path.sep).join('/');}
