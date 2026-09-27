import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {queueKeywordReviews,pendingKeywordReviews,keywordConfigurations} from '../../../../../shared/job-search-core/scripts/lib/source-keyword-maintenance.mjs';
import {commitSourceRepair} from '../../../../../shared/job-search-core/scripts/lib/source-repair.mjs';
const exec=promisify(execFile),script=fileURLToPath(new URL('../../../../../shared/job-search-core/scripts/audit-search-capabilities.mjs',import.meta.url));
const write=async(p,v)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(v));};
async function fixture(t,provider='fixture_public'){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'source-keyword-flow-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const registryFile=path.join(dir,'sources.json'),caps=path.join(dir,'caps.json'),out=path.join(dir,'proofs'),source={company_id:'c',display_name:'Fixture',source_id:'s',provider,primary_entry_url:'https://example.org/jobs'};
 const registry={companies:[source]};await write(registryFile,registry);await queueKeywordReviews({companies:[]},registry,{registryFile});
 const run=(...args)=>exec(process.execPath,[script,'--maintenance','--registry='+registryFile,'--capabilities='+caps,'--out='+out,...args],{windowsHide:true});
 return {dir,registryFile,caps,out,source,registry,run};
}
test('repair registers every direction; old proofs and superseded configurations cannot close new work',async t=>{
 const f=await fixture(t),before=keywordConfigurations(f.registry),oldCaps={configurations:before.map(r=>({...r,status:'verified_native_keyword',support_status:'supported',maintenance_checked_at:'2026-01-01',reason:'verified'}))};
 assert.equal((await pendingKeywordReviews(f.registry,oldCaps,{access:'maintenance',registryFile:f.registryFile})).length,0);
 const result=await commitSourceRepair(f.source,{...f.source,primary_entry_url:'https://example.org/new'},{reason:'verified new contract'},{access:'maintenance',registryFile:f.registryFile});
 assert.equal(result.keyword_review.required,true);assert.equal(result.keyword_review.configurations,3);
 const current=JSON.parse(await fs.readFile(f.registryFile,'utf8'));assert.equal((await pendingKeywordReviews(current,oldCaps,{access:'maintenance',registryFile:f.registryFile})).length,3);
 assert.equal((await queueKeywordReviews(current,current,{access:'maintenance',registryFile:f.registryFile})).required,false);
});
test('maintenance unknown adapter is recorded, dry run and no-publish cannot close the workflow',async t=>{
 const f=await fixture(t);await assert.rejects(f.run('--check'),e=>e.code===2);
 await f.run('--no-publish');await assert.rejects(f.run('--check'),e=>e.code===2);
 await f.run();await f.run('--check');
 const caps=JSON.parse(await fs.readFile(f.caps,'utf8'));assert.equal(caps.configurations.length,3);
 assert(caps.configurations.every(r=>r.support_status==='unconfirmed'&&r.status==='local_title_filter'&&r.reason==='no_confirmed_native_keyword_adapter'));
 await assert.rejects(f.run('--per-provider=1'),/every pending/);
});
test('maintenance replays actual controls for every direction and never trusts a cached success label',async t=>{
 const f=await fixture(t,'moka');
 for(const row of keywordConfigurations(f.registry)){
  const folder=path.join(f.out,row.key,row.mode),absent='zzNoRecruitmentMatch_'+row.key.slice(0,16),job={job_id:'1',title:'Engineer'};
  const response=(keyword,jobs)=>({jobs,coverage:{status:'complete'},requests:[{purpose:'job_list',http_status:200,method:'POST',url:'https://example.org/jobs',body:{keyword,siteId:1}}]});
  await write(path.join(folder,'baseline.json'),response('',[job]));await write(path.join(folder,'positive.json'),response('Engineer',[job]));await write(path.join(folder,'negative.json'),response(absent,row.mode==='social'?[job]:[]));await write(path.join(folder,'proof.json'),{status:'verified_native_keyword'});
 }
 await f.run();await f.run('--check');const rows=JSON.parse(await fs.readFile(f.caps,'utf8')).configurations;
 assert.equal(rows.filter(r=>r.support_status==='supported').length,2);assert.equal(rows.find(r=>r.mode==='social').support_status,'unconfirmed');
});
test('unsupported requires reviewed explicit official contract evidence, not a missing adapter',async t=>{
 const f=await fixture(t),evidence=path.join(f.dir,'contract.txt'),reviewFile=path.join(f.dir,'review.json');await fs.writeFile(evidence,'Synthetic fixture: this API explicitly does not provide keyword filtering.');
 const reviews=keywordConfigurations(f.registry).map(r=>({...r,finding:'official_contract_explicitly_disallows_keyword',evidence_url:'https://example.org/contract',evidence_file:evidence,reviewed_at:'2026-09-26',reason:'Reviewed explicit contract restriction'}));await write(reviewFile,reviews);
 await f.run('--unsupported-review='+reviewFile);await f.run('--check');assert(JSON.parse(await fs.readFile(f.caps,'utf8')).configurations.every(r=>r.support_status==='unsupported'));
});

test('maintenance includes more than ten sources per provider without sampling',async t=>{
 const f=await fixture(t,'moka'),registry={companies:Array.from({length:12},(_,i)=>({...f.source,company_id:'c'+i,source_id:'s'+i}))};
 await write(f.registryFile,registry);await queueKeywordReviews({companies:[]},registry,{access:'maintenance',registryFile:f.registryFile});
 const {stdout}=await f.run('--dry-run'),stats=JSON.parse(stdout.trim());assert.equal(stats.planned,36);assert.equal(stats.maintenance_required,36);
});
test('publication lock refuses concurrent audits and leaves pending work intact',async t=>{
 const f=await fixture(t);await fs.writeFile(f.caps+'.audit.lock','fixture lock');await assert.rejects(f.run(),/Another keyword audit/);
 await assert.rejects(f.run('--check'),e=>e.code===2);await assert.rejects(fs.access(f.caps),{code:'ENOENT'});
});
