import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CORE_ROOT} from '../../runtime-context.mjs';
import {DATA_FILES,bytesHash,assertReleasePath,publicOperationalValue} from '../lib/data-release-contract.mjs';
import {collectEndpoint,collectCompanySources} from '../lib/source-collector.mjs';
import {directionSources} from '../lib/source-directions.mjs';
const source={company_id:'fixture',display_name:'Fixture',provider:'moka',source_id:'main',primary_entry_url:'https://fixture.example/campus-recruitment/org/1',validated_api_request_examples:[{purpose:'job_list',url:'https://fixture.example/api/website/jobs/v2',method:'POST',body:{orgId:'org',siteId:'1',site:'campus-recruitment'}}]};
test('failed collection in every direction never discovers or writes replacement configuration',async t=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'public-readonly-'));t.after(()=>fs.rm(tmp,{recursive:true,force:true}));
 const before=Object.fromEntries(await Promise.all(DATA_FILES.map(async f=>[f,bytesHash(await fs.readFile(path.join(CORE_ROOT,f)))])));
 for(const mode of ['campus','internship','social'])for(const failure of ['timeout','login','schema']){
  const calls=[];t.mock.method(globalThis,'fetch',async url=>{calls.push(String(url));if(failure==='timeout')throw Error('timeout');return new Response(failure==='login'?'login required':'not a configuration',{status:failure==='login'?401:200});});
  const original=structuredClone(source),result=await collectEndpoint(source,{mode:'full',targetMode:mode,maxPages:1,maxDetails:1,evidenceDir:path.join(tmp,mode,failure),requestBudget:{remaining:2}});
  assert.equal(result.coverage.status,'failed');assert.equal(result.repair,undefined);assert.deepEqual(source,original);
  assert.equal(calls.length,1);assert.equal(calls[0],source.primary_entry_url);t.mock.restoreAll();
 }
 for(const f of DATA_FILES)assert.equal(bytesHash(await fs.readFile(path.join(CORE_ROOT,f))),before[f],f);
});
test('one failed released source preserves other sources and never reports complete empty',async()=>{
 const company={...source,recruitment_sources:[source,{...source,source_id:'other',primary_entry_url:'https://other.example/campus-recruitment/org/1'}]};
 const seen=[];const r=await collectCompanySources(company,{mode:'list',targetMode:'campus'},async s=>{seen.push(s.source_id);return {jobs:[],requests:[],coverage:{status:s.source_id==='main'?'failed':'complete',pages:1}};});
 assert.deepEqual(seen,['main','other']);assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.collection_complete,false);
});
test('direction routing uses only released configurations without portal discovery',async t=>{
 t.mock.method(globalThis,'fetch',()=>{throw Error('Discovery forbidden');});const r=await directionSources(source,{targetMode:'social'});
 assert.equal(r.requests.length,0);assert.equal(r.sources.length,1);assert.equal(r.sources[0].primary_entry_url,source.primary_entry_url);assert(r.plan.limitation);
});
test('release contract denies path traversal and omits private repair history',()=>{
 for(const p of ['../outside.json','data/../credentials.json','C:/secret.json','data/extra.json'])assert.throws(()=>assertReleasePath(p));
 assert.deepEqual(publicOperationalValue({company_id:'a',repair_history:[{raw_file:'D:/private/raw.json'}],api_config:{board_token:'public-tenant'},evidence_file:'datasets/raw.json'}),{company_id:'a',api_config:{board_token:'public-tenant'}});
});
