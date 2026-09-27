import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {SKILL_ROOT,writeJson,readJson} from '../lib/io.mjs';
const exec=promisify(execFile);

test('复核前后对象独立，标题城市修复不丢失原待核实记录或改写原快照',async()=>{
 const root=path.join(SKILL_ROOT,'artifacts/implementation/tests/review-pending-'+Date.now());
 const source=path.join(root,'source'),work=path.join(root,'work'),out=path.join(root,'reviewed');
 const company={company_id:'demo',display_name:'示例',selected:true};
 const job={company_id:'demo',company_name:'示例',job_id:'001',title:'项目经理（深圳）',formal_status:'formal',open_status:'open',locations_raw:[],cities:[],body_complete:true,description:'统筹项目计划、资源和交付。',requirements:'本科及以上学历，有项目管理实践。',evaluation_status:'needs_verification'};
 await writeJson(path.join(source,'run.json'),{companies:[company],profile:{city_filters:[]}});
 const file=path.join(source,'companies/demo.json');
 await writeJson(file,{...company,jobs:[job],checked_at:'2026-09-01T00:00:00Z',coverage:{status:'complete'}});
 const before=await fs.readFile(file,'utf8');
 await exec(process.execPath,[path.join(SKILL_ROOT,'scripts/review-pending.mjs'),'--source',source,'--work',work,'--out',out],{cwd:SKILL_ROOT});
 const audit=await readJson(path.join(out,'verification-review.json'));
 assert.equal(audit.reviewed_count,1);assert.equal(audit.results.to_assess,1);
 assert.equal(audit.items[0].before.status,'needs_verification');
 assert.deepEqual(audit.items[0].before.cities,[]);
 assert.deepEqual(audit.items[0].after.cities,['深圳']);
 assert.equal(await fs.readFile(file,'utf8'),before);
 assert.equal((await readJson(path.join(out,'companies/demo.json'))).checked_at,'2026-09-01T00:00:00Z');
});
