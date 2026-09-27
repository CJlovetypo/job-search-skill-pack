import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openDb,normalizeConfig,subscribe,runSubscription,renderReport} from '../radar.mjs';

const companies=[{company_id:'a',display_name:'示例公司',industry_tags:['internet']}];
const config={id:'pm',mode:'social',keywords:['项目经理'],cities:['上海'],industries:['internet'],retrieval:{mode:'targeted',selection:'explicit',basis:'用户选择标题定向'},keyword_reasons:[{keyword:'项目经理',reason:'用户明确岗位名称'},{keyword:'经理',reason:'用户更新岗位名称'}]};
const job={job_id:'1',title:'项目经理',cities:['上海'],formal_status:'social',open_status:'open',body_complete:true,description:'负责开发',official_url:'https://example.com/job/1',job_url_kind:'official_detail'};
function fixture(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'radar-')); const db=openDb(path.join(dir,'db.sqlite'));t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});}); subscribe(db,normalizeConfig(config,companies));return db;}
const context={registry:{companies},cities:{social:{companies:[{company_id:'a',cities:['上海']}]}}};
const run=(db,id,cs,collector)=>runSubscription(db,id,cs,collector,{context});
const collect=(jobs,status='complete')=>async()=>({jobs,coverage:{status}});
const events=(db,run)=>db.prepare('SELECT kind FROM events WHERE run=?').all(run).map(x=>x.kind);
test('持久去重、内容更新、完整扫描未见及重现；失败和部分覆盖不推断消失',async t=>{
  const db=fixture(t);
  let r=await run(db,'pm',companies,collect([job])); assert.deepEqual(events(db,r),['new']);
  assert.match(renderReport(db,r),/首次发现 \*\*1\*\*/);
  r=await run(db,'pm',companies,collect([{...job,checked_at:'tomorrow'}]));assert.deepEqual(events(db,r),[]);
  r=await run(db,'pm',companies,collect([{...job,description:'负责团队开发'}]));assert.deepEqual(events(db,r),['updated']);
  for (const status of ['partial','failed']) {r=await run(db,'pm',companies,collect([],status));assert.deepEqual(events(db,r),[]);assert.match(renderReport(db,r),/不能判断为没有招聘/);}
  r=await run(db,'pm',companies,collect([]));assert.deepEqual(events(db,r),['missing']);
  r=await run(db,'pm',companies,collect([job]));assert.deepEqual(events(db,r),['reappeared']);
});
test('配置版本隔离、未知信息、明确类型冲突和城市筛选',async t=>{
  const db=fixture(t);
  assert.equal(subscribe(db,normalizeConfig(config,companies)).revision,1);
  const r=await run(db,'pm',companies,collect([job,{...job,job_id:'2',cities:[],body_complete:false,formal_status:'unknown'},{...job,job_id:'3',cities:['北京']},{...job,job_id:'4',formal_status:'internship'}]));
  assert.equal(events(db,r).length,2);assert.match(renderReport(db,r),/招聘类型、城市、JD正文/);
  assert.equal(subscribe(db,normalizeConfig({...config,keywords:['经理']},companies)).revision,2);
  const next=await run(db,'pm',companies,collect([job]));assert.deepEqual(events(db,next),['new']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n,3);
});
test('暂停、同订阅并发保护、输入校验、危险链接不渲染',async t=>{
  const db=fixture(t);
  assert.throws(()=>normalizeConfig({...config,company_ids:['missing']},companies),/未收录/);
  assert.throws(()=>normalizeConfig({id:'all',mode:'social'},companies),/至少/);
  let release;const gate=new Promise(r=>{release=r;});
  const pending=run(db,'pm',companies,async()=>{await gate;return {jobs:[{...job,official_url:'javascript:alert(1)'}],coverage:{status:'complete'}};});
  await assert.rejects(run(db,'pm',companies,collect([])),/UNIQUE/);
  release();const r=await pending;assert.doesNotMatch(renderReport(db,r),/javascript:/);
  db.prepare('UPDATE subscriptions SET enabled=0').run();await assert.rejects(run(db,'pm',companies,collect([])),/暂停/);
});
test('CLI 进程之间持久保存订阅，暂停不会被重复订阅重置',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'radar-cli-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'watch.json'), db=path.join(dir,'radar.sqlite');
  fs.writeFileSync(file,JSON.stringify(config));
  const cli=(...args)=>{const r=spawnSync(process.execPath,[fileURLToPath(new URL('../radar.mjs',import.meta.url)),...args,'--db',db],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;};
  assert.equal(JSON.parse(cli('subscribe','--file',file)).revision,1);
  cli('pause','--id','pm');cli('subscribe','--file',file);
  assert.equal(JSON.parse(cli('list'))[0].enabled,0);
  cli('resume','--id','pm');assert.equal(JSON.parse(cli('list'))[0].enabled,1);
  assert.deepEqual(JSON.parse(cli('runs','--id','pm')),[]);
});
