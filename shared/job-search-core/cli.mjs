// Internal process boundary: one recruitment mode per process.
import {configureRuntime} from './runtime-context.mjs';
const [mode,command,...args]=process.argv.slice(2);
process.argv=[process.execPath,process.argv[1],...(command==='company-profiles'?args:[command,...args])];
configureRuntime({mode});
if(command==='refresh-cities'){
 const {main}=await import('./scripts/refresh-cities.mjs');console.log(JSON.stringify(await main(['--mode',mode,...args])));
}else if(command==='company-profiles')await import('./scripts/company-profiles.mjs');
else throw Error('求职命令已迁至 job-search/scripts/jobs.mjs；请使用该公开入口并指定 --mode。');
