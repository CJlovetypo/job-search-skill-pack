import fs from 'node:fs/promises';
import path from 'node:path';
import {CORE_ROOT} from '../../runtime-context.mjs';
import {bytesHash,assertReleasePath} from './data-release-contract.mjs';

export const PUBLICATION_STATE_FILE=path.join(CORE_ROOT,'data/.publication-state.json');
export async function readPublicationState(file=PUBLICATION_STATE_FILE){
  try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}
}
const checked=new Map();
async function releaseState(root){
 const file=path.join(root,'data/public-release.json'),text=await readPublicationState(file);
 if(!text)return null;
 const manifest=JSON.parse(text),stats=[];
 for(const [relative,digest]of Object.entries(manifest.hashes||{})){
  assertReleasePath(relative);const target=path.join(root,relative),stat=await fs.stat(target),stamp=[stat.mtimeMs,stat.ctimeMs,stat.size].join(':');
  const key=target+'|'+digest;if(checked.get(key)!==stamp){if(bytesHash(await fs.readFile(target))!==digest)throw Error('正式数据版本不完整，请完成版本更新后重试');checked.set(key,stamp);}
  stats.push(relative+':'+stamp);
 }
 return text+'\n'+stats.join('\n');
}
// Readers need only public files, including while maintenance is interrupted.
// Fail closed instead of returning a mixture of two generations.
export async function readConsistentPublic(reader,{marker=PUBLICATION_STATE_FILE}={}){
  const before=await readPublicationState(marker);
  if(before&&JSON.parse(before).status!=='stable')throw Error('公司数据正在发布或等待恢复，请稍后重试');
  const release=path.resolve(marker)===path.resolve(PUBLICATION_STATE_FILE)?await releaseState(CORE_ROOT):null;
  const result=await reader();
  if(before!==await readPublicationState(marker))throw Error('公司数据在读取期间发生变化，请重试');
  if(release!==null&&release!==await releaseState(CORE_ROOT))throw Error('正式数据版本在读取期间变化，请重试');
  return result;
}
