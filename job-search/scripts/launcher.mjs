import {configureJobSearch} from './runtime.mjs';
export async function runCli({mode},command='jobs'){
  configureJobSearch(mode);
  if(command==='jobs')return import('./workflow.mjs');
  throw Error('未知求职命令');
}
