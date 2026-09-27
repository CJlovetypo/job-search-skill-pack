import path from 'node:path';
import {PACK_ROOT,configureRuntime} from '../../shared/job-search-core/runtime-context.mjs';
export const MODE_ROOTS=Object.freeze({campus:'job-search/runtime/campus',internship:'job-search/runtime/internship',social:'job-search/runtime/social'});
export function configureJobSearch(mode){
  if(!MODE_ROOTS[mode])throw Error('需要明确招聘方向');
  return configureRuntime({mode,outputRoot:path.join(PACK_ROOT,MODE_ROOTS[mode])});
}
