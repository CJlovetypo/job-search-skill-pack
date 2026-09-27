import {MODE_ROOTS} from '../../../../scripts/runtime.mjs';
import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {PACK_ROOT,recruitmentFile} from '../../../../../shared/job-search-core/runtime-context.mjs';
import {SOURCE_REGISTRY_FILE,CUSTOM_PROVIDERS_FILE,datasetPath,readSourceRegistry} from '../../../../../shared/job-search-core/registry.mjs';
import {sourceConfigFingerprint} from '../../../../../shared/job-search-core/scripts/lib/source-collector.mjs';
import {validatedDirectionRegistry} from '../../../../../shared/job-search-core/scripts/lib/direction-validation.mjs';
const exec=promisify(execFile);
const cli=(mode,...args)=>exec(process.execPath,[path.join(PACK_ROOT,MODE_ROOTS[mode],'scripts',mode==='campus'?'campus.mjs':'jobs.mjs'),...args],{windowsHide:true,maxBuffer:8e6});

test('migrated resume helpers for all three directions resolve the shared extractor and preserve input',async()=>{
 const python=process.env.CAMPUS_JOB_FIT_PYTHON||'python';
 for(const [mode,relative] of Object.entries(MODE_ROOTS)){
  const root=path.join(PACK_ROOT,relative),parent=path.join(root,'tmp');await fs.mkdir(parent,{recursive:true});
  const dir=await fs.mkdtemp(path.join(parent,'resume-migration-')),input=path.join(dir,'resume.txt'),out=path.join(dir,'extracted.txt');
  const text='合成测试简历：我在课程项目中负责整理需求、安排进度、记录风险和组织阶段复盘，完成了项目文档。';await fs.writeFile(input,text);
  const result=JSON.parse((await exec(python,[path.join(root,'scripts/extract_resume.py'),input,'--out',out],{windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}})).stdout);
  assert.equal(result.characters,text.length);assert.equal(await fs.readFile(input,'utf8'),text);assert.equal((await fs.readFile(out,'utf8')).replaceAll('\r\n','\n'),text+'\n');
  const other=path.join(PACK_ROOT,MODE_ROOTS[mode==='social'?'campus':'social'],'tmp','forbidden-extract.txt');
  await assert.rejects(exec(python,[path.join(root,'scripts/extract_resume.py'),input,'--out',other],{windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}}),e=>/产物必须位于/.test(e.stderr));
 }
});

test('all three real entrypoints load one live registry, with every configuration enabled',async()=>{
 const registry=await readSourceRegistry(),count=registry.companies.reduce((n,c)=>n+(c.recruitment_sources?.length||1),0);
 await Promise.all(Object.entries(MODE_ROOTS).map(async([mode,name])=>{
  const root=path.join(PACK_ROOT,name),result=JSON.parse((await cli(mode,'industries')).stdout);
  assert.equal(result.all_companies,registry.companies.length);
  assert.equal(datasetPath(root,'assets/sources.json'),SOURCE_REGISTRY_FILE);
  assert.equal(datasetPath(root,'assets/custom-providers.json'),CUSTOM_PROVIDERS_FILE);
  await assert.rejects(fs.access(path.join(root,'assets/sources.json')),{code:'ENOENT'});
  if(mode!=='campus')assert.equal(result.source_validation.enabled_configurations,count);
  assert.equal(datasetPath(root,'data/company-city-index.json'),path.join(root,'data/company-city-index.json'));
 }));
});

test('compatibility imports use the same collector implementation and preserve mode-specific fingerprints',async()=>{
 const modules=await Promise.all(Object.values(MODE_ROOTS).map(name=>import(pathToFileURL(path.join(PACK_ROOT,name,'scripts/lib/source-collector.mjs')))));
 assert(modules.every(m=>m.collectCompanySources===modules[0].collectCompanySources));
 const company=(await readSourceRegistry()).companies[0];
 assert.equal(new Set(Object.keys(MODE_ROOTS).map(mode=>sourceConfigFingerprint(company,mode))).size,3);
});

test('each isolated runtime has its own mode, profile requirements and output boundary',async()=>{
 await Promise.all(Object.entries(MODE_ROOTS).map(async([mode,name])=>{
  const script=`import {configureRuntime} from ${JSON.stringify(pathToFileURL(path.join(PACK_ROOT,'shared/job-search-core/runtime-context.mjs')).href)};
    configureRuntime({mode:${JSON.stringify(mode)},outputRoot:${JSON.stringify(path.join(PACK_ROOT,name))}});
    const io=await import(${JSON.stringify(pathToFileURL(path.join(PACK_ROOT,'shared/job-search-core/scripts/lib/io.mjs')).href)});
    const policy=await import(${JSON.stringify(pathToFileURL(path.join(PACK_ROOT,'shared/job-search-core/scripts/lib/search-mode.mjs')).href)});
    let refused=false;try{configureRuntime({mode:${JSON.stringify(mode==='social'?'campus':'social')}});}catch{refused=true;}
    const profile={degree:'本科',graduation:'2027-06',employment_years:3};
    console.log(JSON.stringify({root:io.SKILL_ROOT,mode:policy.SEARCH_MODE.id,report:policy.SEARCH_MODE.report,refused,problem:policy.modeProfileProblem(profile)}));`;
  const {stdout}=await exec(process.execPath,['--input-type=module','-e',script],{windowsHide:true});
  const result=JSON.parse(stdout);assert.equal(result.root,path.join(PACK_ROOT,name));assert.equal(result.mode,mode);assert(result.refused);
  if(mode==='internship')assert(result.problem);else assert.equal(result.problem,null);
  assert.equal(result.report,{campus:'校招岗位匹配.xlsx',internship:'实习岗位匹配.xlsx',social:'社招岗位匹配.xlsx'}[mode]);
 }));
});

test('cross-skill run paths are rejected before reading, collecting, planning or rendering',async()=>{
 await Promise.all(Object.keys(MODE_ROOTS).map(async mode=>{
  const other=path.join(PACK_ROOT,MODE_ROOTS[mode==='social'?'campus':'social'],'runs/must-not-be-read');
  for(const command of ['collect','screening-summary','plan-assessment','render']){
   await assert.rejects(cli(mode,command,'--run',other),error=>/输出必须位于本 skill 文件夹内/.test(error.stderr));
  }
 }));
});

test('new or changed shared source configs remain enabled without inheriting stale direction proof',async()=>{
 const registry=await readSourceRegistry();
 for(const mode of ['internship','social']){
  const proof=JSON.parse(await fs.readFile(recruitmentFile(mode,'source-direction-validation.json'),'utf8'));
  const before=validatedDirectionRegistry(registry.companies,proof,mode),changed=structuredClone(registry.companies);
  changed.push({company_id:'shared-source-regression-fixture',display_name:'Fixture',provider:'beisen',primary_entry_url:'https://example.invalid'});
  const after=validatedDirectionRegistry(changed,proof,mode);
  assert.equal(after.enabled_configurations,before.enabled_configurations+1);
  assert.equal(after.unverified_configurations,before.unverified_configurations+1);
  const accepted=proof.configurations.find(r=>r.proof?.accepted),company=changed.find(c=>c.company_id===accepted.company_id);
  const sources=company.recruitment_sources?.length?company.recruitment_sources:[company];
  const source=sources.find(s=>s.source_id===accepted.source_id)||sources[0];source.primary_entry_url+='?changed=1';
  const stale=validatedDirectionRegistry(changed,proof,mode);
  assert(stale.unverified_configurations>after.unverified_configurations);
  assert.equal(stale.enabled_configurations,after.enabled_configurations);
 }
});
