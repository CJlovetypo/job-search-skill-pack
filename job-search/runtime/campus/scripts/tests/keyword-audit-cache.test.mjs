import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {replayKeywordAudit} from '../../../../../shared/job-search-core/scripts/lib/keyword-audit-cache.mjs';
import {readSourceRegistry} from '../../../../../shared/job-search-core/registry.mjs';
import {directionSourceKey} from '../../../../../shared/job-search-core/scripts/lib/direction-validation.mjs';

test('cached audit conclusions are recomputed from archived requests and jobs',async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'keyword-cache-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const key='example-source-key',keyword='Engineer',absent='zzNoRecruitmentMatch_'+key.slice(0,16),checked_at='2026-09-19T00:00:00Z';
 const job={job_id:'1',title:keyword};
 const response=(word,jobs)=>({jobs,coverage:{status:'complete'},requests:[{purpose:'job_list',http_status:200,url:'https://example.org/jobs',method:'POST',body:{keyword:word,siteId:1}}]});
 const original={baseline:response('',[job]),positive:response(keyword,[job]),negative:response(absent,[])};
 const write=async data=>Promise.all(Object.entries(data).map(([name,value])=>fs.writeFile(path.join(folder,name+'.json'),JSON.stringify(value))));
 const run=()=>replayKeywordAudit({folder,provider:'moka',key},{status:'verified_native_keyword',checked_at,proof:{positive_match:true}});
 await write(original);let result=await run();assert.equal(result.status,'verified_native_keyword');assert.equal(result.checked_at,checked_at);
 for(const bad of [
  {...original,positive:response(keyword,[{...job,job_id:'other'}])},
  {...original,negative:response(absent,[job])},
  {...original,negative:{...response(absent,[]),coverage:{status:'partial'}}},
  {...original,negative:response('',[])},
  {...original,negative:{...response(absent,[]),requests:[{...response(absent,[]).requests[0],url:'https://example.org/other'}]}}
 ]){await write(bad);result=await run();assert.equal(result.status,'parameter_candidate');assert.equal(result.checked_at,checked_at);}
 await write(original);await fs.unlink(path.join(folder,'negative.json'));result=await run();assert.equal(result.status,'parameter_candidate');assert.equal(result.proof,null);assert.equal(result.checked_at,checked_at);
 assert.equal(result.reason,'cached_evidence_missing');assert.equal(result.reason.includes(folder),false);
 await fs.writeFile(path.join(folder,'negative.json'),'{broken');result=await run();assert.equal(result.status,'parameter_candidate');assert.equal(result.reason,'cached_evidence_invalid_json');
 await write({baseline:response('',[])});await fs.unlink(path.join(folder,'positive.json'));await fs.unlink(path.join(folder,'negative.json'));
 result=await run();assert.equal(result.status,'parameter_candidate');assert.equal(result.reason,'baseline_empty_or_unavailable');assert.equal(result.checked_at,checked_at);
});

test('replay-only selects every saved proof, preserves the first snapshot and never collects missing evidence',async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'keyword-replay-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const sources=[];for(const company of (await readSourceRegistry()).companies)for(const [index,source]of(company.recruitment_sources?.length?company.recruitment_sources:[company]).entries())if(source.provider==='moka')sources.push({company,source,index});
 assert.ok(sources.length>=11);
 for(const {company,source,index}of sources.slice(0,11)){
  const dest=path.join(folder,directionSourceKey(company,source,index),'campus');await fs.mkdir(dest,{recursive:true});
  await fs.writeFile(path.join(dest,'proof.json'),JSON.stringify({status:'verified_native_keyword',checked_at:'2026-09-19T00:00:00Z'}));
 }
 const snapshot='{"keep":"original snapshot"}\n';await fs.writeFile(path.join(folder,'previous-capabilities.json'),snapshot);
 const script=fileURLToPath(new URL('../audit-search-capabilities.mjs',import.meta.url)),exec=promisify(execFile);
 await exec(process.execPath,[script,'--replay-only','--no-publish','--providers=moka','--out='+folder],{timeout:30000});
 const summary=JSON.parse(await fs.readFile(path.join(folder,'summary.json'),'utf8'));assert.equal(summary.planned,11);assert.equal(summary.completed,11);
 assert.equal(await fs.readFile(path.join(folder,'previous-capabilities.json'),'utf8'),snapshot);
 const first=sources[0],proof=JSON.parse(await fs.readFile(path.join(folder,directionSourceKey(first.company,first.source,first.index),'campus','proof.json'),'utf8'));
 assert.equal(proof.status,'parameter_candidate');assert.equal(proof.checked_at,'2026-09-19T00:00:00Z');
 await assert.rejects(exec(process.execPath,[script,'--replay-only','--pending','--no-publish','--out='+folder]),/cannot be combined/);
});

test('alternative title phrases must be reconstructible and actually sent',async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'keyword-phrase-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const key='example-key',job={job_id:'1',title:'Senior Engineer - Platform'},absent='zzNoRecruitmentMatch_'+key.slice(0,16);
 const response=(word,jobs)=>({jobs,coverage:{status:'complete'},requests:[{purpose:'job_list',http_status:200,url:'https://example.org/jobs',method:'POST',body:{keyword:word}}]});
 for(const [name,result]of Object.entries({baseline:response('',[job]),positive:response('Senior Engineer',[job]),negative:response(absent,[])}))await fs.writeFile(path.join(folder,name+'.json'),JSON.stringify(result));
 const run=word=>replayKeywordAudit({folder,provider:'moka',key},{proof:{positive_keyword:word}});
 assert.equal((await run('Senior Engineer')).status,'verified_native_keyword');
 assert.equal((await run('Unrelated words')).status,'parameter_candidate');
 assert.equal((await run('Senior Engineer Platform')).status,'parameter_candidate');
});
