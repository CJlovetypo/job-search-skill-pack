import {runCli} from './launcher.mjs';
const [mode,command,...args]=process.argv.slice(2);
process.argv=[process.execPath,process.argv[1],command,...args];
await runCli({mode},'jobs');
