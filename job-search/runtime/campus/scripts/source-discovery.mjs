import {pathToFileURL} from 'node:url';
import path from 'node:path';
export * from '../../../../shared/job-search-core/scripts/source-discovery.mjs';
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const {configureJobSearch}=await import('../../../scripts/runtime.mjs');configureJobSearch('campus');
 const {main}=await import('../../../../shared/job-search-core/scripts/source-discovery.mjs');await main();
}
