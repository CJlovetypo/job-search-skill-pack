import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {collectIvva} from '../../../../../shared/job-search-core/scripts/lib/providers-ivva.mjs';
import {collectUgreen} from '../../../../../shared/job-search-core/scripts/lib/provider-ugreen.mjs';
import {collectCvte} from '../../../../../shared/job-search-core/scripts/lib/provider-cvte.mjs';
import {createMaintenanceScope,withMaintenanceNetworkScope} from '../../../../../shared/job-search-core/scripts/lib/maintenance-network-scope.mjs';
import {SEARCH_MODE,withSearchMode} from '../../../../../shared/job-search-core/scripts/lib/search-mode.mjs';

test('concurrent collectors keep separate explicit recruitment modes without changing product runtime',async()=>{
  const values=await Promise.all(['campus','social','internship'].map(mode=>withSearchMode(mode,async()=>{
    await new Promise(resolve=>setTimeout(resolve,5));assert.equal(SEARCH_MODE.id,mode);return SEARCH_MODE.id;
  })));
  assert.deepEqual(values,['campus','social','internship']);
  assert.throws(()=>SEARCH_MODE.id,/未知招聘方向/);
});

async function fixture(t,handler){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'longtail-budget-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  t.mock.method(globalThis,'fetch',handler);
  return dir;
}
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});

test('CVTE preserves the sampled project when further projects exceed the budget',async t=>{
  let hits=0;const evidenceDir=await fixture(t,async url=>{hits++;return String(url).endsWith('/project')?json({projects:[{id:'one',name:'校园招聘'},{id:'two',name:'校园招聘'}]}):json({projectPositions:[{id:'job',name:'工程师'}]});});
  const scope=createMaintenanceScope({maxPages:1});
  const r=await withMaintenanceNetworkScope(scope,()=>collectCvte({company_id:'fixture'},{evidenceDir,maxPages:10}));
  assert.equal(hits,2);assert.equal(r.jobs.length,1);assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.list_complete,false);assert.match(r.coverage.reason,/budget_exhausted/);
});

test('IVVA keeps acquired rows and evidence when the shared page budget stops pagination',async t=>{
  let hits=0;
  const evidenceDir=await fixture(t,async(url,options)=>{hits++;assert(options.signal);return String(url).includes('getCompOfficialWebsiteToken')?json({success:true,data:{token1:'campus'}}):json({success:true,listData:[{positionId:1,positionName:'工程师',positionDesc:'负责技术开发。任职要求：本科及以上。',isSchoolRecruit:1,positionNature:'全职'}],pageModel:{rowCount:2}});});
  const scope=createMaintenanceScope({maxPages:1,maxRequests:5});
  const r=await withMaintenanceNetworkScope(scope,()=>collectIvva({company_id:'fixture',primary_entry_url:'https://talent.biomap-inc.com/company/test'},{evidenceDir,maxPages:10}));
  assert.equal(hits,2);assert.equal(r.jobs.length,1);assert.equal(r.coverage.list_complete,false);assert.match(r.coverage.reason,/maintenance_list_budget_exhausted/);assert.equal(scope.records.length,2);
  assert(r.requests.every(x=>x.response_sha256));
});

test('Ugreen signed requests consume shared budget and never persist authorization',async t=>{
  let hits=0;
  const evidenceDir=await fixture(t,async(url,options)=>{
    hits++;
    if(String(url).endsWith('/campus'))return new Response('<script src="/main.js"></script>');
    if(String(url).endsWith('/main.js'))return new Response('"&&appSecret=public-site-value"');
    assert.equal(options.redirect,'manual');assert(options.signal);assert(options.headers.Authorization);
    return json({staus:'success',data:[]});
  });
  const scope=createMaintenanceScope({maxRequests:3,maxPages:2});
  await assert.rejects(withMaintenanceNetworkScope(scope,()=>collectUgreen({company_id:'fixture'},{evidenceDir})),/maintenance_request_budget_exhausted/);
  assert.equal(hits,3);assert.equal(scope.records.filter(x=>x.http_status===200).length,3);
  assert(!JSON.stringify(scope.records).includes('public-site-value'));
  assert(!scope.records.some(x=>x.headers?.Authorization));
});
