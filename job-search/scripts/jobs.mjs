import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {PACK_ROOT} from '../../shared/job-search-core/runtime-context.mjs';
import {decideTask,reviseTask,taskFingerprint,MODES} from '../../shared/job-search-core/scripts/lib/task-decision.mjs';

const [command,...args]=process.argv.slice(2);
const read=async file=>JSON.parse(await fs.readFile(path.resolve(file),'utf8'));
const value=name=>{const i=args.indexOf('--'+name);return i>=0&&args[i+1]&&!args[i+1].startsWith('--')?args[i+1]:undefined;};
async function main(){
  if(['task-check','task-show','task-save'].includes(command)){
    if(!value('file'))throw Error('需要 --file 任务记录');
    let task=await read(value('file'));
    if(value('previous'))task=reviseTask(await read(value('previous')),task);
    const decision=decideTask(task);
    if(!decision.valid){console.log(JSON.stringify(decision));process.exitCode=2;return;}
    if(command==='task-save'){
      if(!value('out'))throw Error('task-save 需要 --out 新修订路径');
      const out=path.resolve(value('out')),root=path.join(PACK_ROOT,'job-search','runs'),relative=path.relative(root,out);
      if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('任务记录必须位于 job-search/runs 内');
      await fs.mkdir(path.dirname(out),{recursive:true});
      await fs.writeFile(out,JSON.stringify(task,null,2)+'\n',{encoding:'utf8',flag:'wx'});
      console.log(JSON.stringify({file:out,fingerprint:taskFingerprint(task),decision}));return;
    }
    console.log(JSON.stringify({task,decision}));return;
  }
  if(!command||command==='help'){
    console.log('task-check/task-save --file 任务.json；industries；catalog/prepare/collect/plan-assessment/batch-*/render --mode campus|internship|social。prepare 需 --task；纯发现加 --discovery 后用 render-discovery。plan-assessment 用 --scope-mode sample|companies|all。company-profiles --mode 方向 status|sync|import；运行/输出位于 job-search/runtime/<方向>。');return;
  }
  const task=value('task')?await read(value('task')):null;
  const run=value('run')?await read(path.join(value('run'),'run.json')):null;
  const mode=value('mode')||task?.conditions?.recruitment?.value||run?.search_mode||(run?'campus':null)||(command==='industries'?'campus':null);
  if(!MODES.includes(mode))throw Error('需要明确 --mode campus/internship/social，不能默认招聘方向');
  if(command==='prepare'&&!task)throw Error('统一入口 prepare 需要 --task，先整理并保存本轮任务');
  if(task){const decision=decideTask(task);if(!decision.valid)throw Error(decision.errors.join('；'));if(decision.mode&&decision.mode!==mode)throw Error('任务与 --mode 招聘方向冲突');}
  const forwarded=[];
  for(let i=0;i<args.length;i++){
    if(args[i]==='--mode'){i++;continue;}
    forwarded.push(args[i]==='--scope-mode'?'--mode':args[i]);
  }
  const entry=path.join(PACK_ROOT,'job-search/scripts/cli.mjs');
  const child=spawn(process.execPath,[entry,mode,command,...forwarded],{stdio:'inherit',windowsHide:true});
  process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
