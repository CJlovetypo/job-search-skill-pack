import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {collectCustom} from '../lib/providers-custom.mjs';
import {collectCommon} from '../lib/providers-common.mjs';
import {SKILL_ROOT} from '../lib/io.mjs';
import {MODE_ROOTS} from '../../../../scripts/runtime.mjs';
import {PACK_ROOT} from '../../../../../shared/job-search-core/runtime-context.mjs';

test('bulk page-size hints stay within Baidu and Ant public request limits',async()=>{
 const previous=globalThis.fetch,seen=[];
 try{
  globalThis.fetch=async(url,init)=>{
   const form=String(init.headers['Content-Type']||init.headers['content-type']).includes('form');
   const body=form?Object.fromEntries(new URLSearchParams(init.body)):JSON.parse(init.body);
   seen.push({url,size:Number(body.pageSize)});
   return new Response(JSON.stringify(String(url).includes('talent.baidu')?{data:{list:[],total:0}}:{success:true,content:[],totalCount:0}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  for(const [provider,name] of [['baidu','百度'],['antgroup','蚂蚁集团']])for(const pageSize of [100,5]){
   const result=await collectCustom({company_id:provider,display_name:name,provider},{pageSize,maxPages:1,mode:'list',evidenceDir:path.join(SKILL_ROOT,'artifacts/tests/page-limits',provider+'-'+pageSize)});
   assert.equal(result.coverage.status,'complete');
  }
  assert.deepEqual(seen.map(r=>r.size),[20,5,20,5]);
 }finally{globalThis.fetch=previous;}
});

test('closed Moka portal reports closure without requesting encrypted job lists',async()=>{
 const previous=globalThis.fetch;let requests=0;
 try{
  globalThis.fetch=async()=>{requests++;return new Response('<input id="init-data" value="{&quot;message&quot;:&quot;当前网页已关停&quot;}">',{status:200});};
  const entry='https://fixture.example/campus-recruitment/demo/10';
  const source={company_id:'fixture',display_name:'Fixture',provider:'moka',primary_entry_url:entry,validated_api_request_examples:[{url:'https://fixture.example/api/outer/ats-apply/website/jobs/v2',method:'POST',body:{orgId:'demo',siteId:'10',site:'campus-recruitment'}}]};
  const result=await collectCommon(source,{mode:'list',maxPages:1,evidenceDir:path.join(SKILL_ROOT,'artifacts/tests/closed-portal')});
  assert.equal(result.coverage.status,'failed');assert.match(result.coverage.reason,/portal closed/);assert.equal(requests,1);
 }finally{globalThis.fetch=previous;}
});

test('all distributable entrypoints and their documentation dependencies exist',async()=>{
 assert.deepEqual(Object.values(MODE_ROOTS).sort(),['job-search/runtime/campus','job-search/runtime/internship','job-search/runtime/social'].sort());
 for(const [mode,name] of Object.entries(MODE_ROOTS)){
  const root=path.join(PACK_ROOT,name);
  await assert.rejects(fs.access(path.join(root,'SKILL.md')));
  await assert.rejects(fs.access(path.join(root,'agents')));
  await fs.access(path.join(root,'scripts',mode==='campus'?'campus.mjs':'jobs.mjs'));
  for(const file of ['assessment.md','ability-model.md','workflow.md'])await fs.access(path.join(root,'references',file));
 }
 const root=path.join(PACK_ROOT,'job-search'),skill=await fs.readFile(path.join(root,'SKILL.md'),'utf8');assert.match(skill,/name: job-search/);
 for(const match of skill.matchAll(/\[[^\]]+\]\(([^)]+)\)/g))if(!/^https?:/.test(match[1]))await fs.access(path.resolve(root,decodeURIComponent(match[1].split('#')[0])));
});

test('retired direction Skills have no discoverable instructions or agent metadata',async()=>{
 for(const name of ['campus-job-fit','internship-job-fit','social-job-fit']){
  await assert.rejects(fs.access(path.join(PACK_ROOT,name,'SKILL.md')));
  await assert.rejects(fs.access(path.join(PACK_ROOT,name,'agents')));
 }
 const cli=await fs.readFile(path.join(PACK_ROOT,'job-search/scripts/jobs.mjs'),'utf8');
 assert(cli.includes('job-search/scripts/cli.mjs'));
 assert(!/campus-job-fit|internship-job-fit|social-job-fit/.test(cli));
});
