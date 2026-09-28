import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CORE_ROOT} from '../../runtime-context.mjs';
import {readConsistentPublic} from '../lib/public-snapshot.mjs';

test('a published file with unexpected bytes blocks public readers before consumption',async t=>{
 const original=fs.readFile.bind(fs),target=path.join(CORE_ROOT,'assets/sources.json');let consumed=false;
 t.mock.method(fs,'readFile',async(file,...args)=>path.resolve(String(file))===target?Buffer.from('{"interrupted":"update"}'):original(file,...args));
 await assert.rejects(readConsistentPublic(()=>{consumed=true;}),/版本不完整/);assert.equal(consumed,false);
});

test('an interrupted publication blocks readers until recovered',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'snapshot-state-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const marker=path.join(dir,'state.json');
 await fs.writeFile(marker,JSON.stringify({status:'applying'}));await assert.rejects(readConsistentPublic(()=>42,{marker}),/等待恢复/);
 await fs.writeFile(marker,JSON.stringify({status:'stable',generation:2}));assert.equal(await readConsistentPublic(()=>42,{marker}),42);
});

test('a version switch during reading never returns mixed results',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'snapshot-switch-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const marker=path.join(dir,'state.json');
 await fs.writeFile(marker,JSON.stringify({status:'stable',generation:1}));
 await assert.rejects(readConsistentPublic(async()=>{await fs.writeFile(marker,JSON.stringify({status:'stable',generation:2}));return 42;},{marker}),/读取期间发生变化/);
});
