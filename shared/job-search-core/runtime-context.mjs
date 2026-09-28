import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const CORE_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PACK_ROOT = path.resolve(CORE_ROOT, '../..');
export const MODES = Object.freeze(['campus','internship','social']);
export const MODE_ROOTS = Object.freeze(Object.fromEntries(MODES.map(mode => [mode, `shared/job-search-core/data/recruitment/${mode}`])));
export function recruitmentFile(mode, name='company-city-index.json') {
  if (!MODES.includes(mode) || !['company-city-index.json','source-direction-validation.json','shared-registry.json','source-mode-capabilities.json'].includes(name)) throw Error('无效的正式招聘方向数据');
  return path.join(PACK_ROOT, MODE_ROOTS[mode], name);
}
let selected;
export let runtimeRoot = CORE_ROOT;
export function configureRuntime({mode,skillRoot,outputRoot,evidenceRoot,cacheRoot}={}) {
  if (!MODES.includes(mode)) throw Error('运行上下文需要明确招聘方向');
  const root=path.resolve(outputRoot||skillRoot||path.join(CORE_ROOT,'state','runtime',mode));
  const next={mode,skillRoot:root,outputRoot:root,evidenceRoot:path.resolve(evidenceRoot||path.join(root,'artifacts')),cacheRoot:path.resolve(cacheRoot||path.join(root,'artifacts','channel-discovery'))};
  if(selected&&JSON.stringify(selected)!==JSON.stringify(next))throw Error('同一运行进程不能切换招聘方向或输出上下文；请启动独立进程或 Worker');
  selected ||= Object.freeze(next);runtimeRoot=root;return selected;
}

export function runtimeContext() {
  return selected || {mode:null,skillRoot:CORE_ROOT,outputRoot:CORE_ROOT,evidenceRoot:path.join(CORE_ROOT,'state','evidence'),cacheRoot:path.join(CORE_ROOT,'state','channel-discovery')};
}
