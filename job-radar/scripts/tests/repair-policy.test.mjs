import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assertAutomaticRepair} from '../../../shared/job-search-core/scripts/lib/repair-policy.mjs';
import {commitSourceRepair,recoverSourceRepair} from '../../../shared/job-search-core/scripts/lib/source-repair.mjs';
const old={company_id:'fixture',source_id:'main',provider:'moka',primary_entry_url:'https://example.invalid/campus-recruitment/org/1',identity_verification:{identity_verified:true},validated_api_request_examples:[{url:'https://example.invalid/api/outer/ats-apply/website/jobs/v2',method:'POST',body:{orgId:'org',site:'campus-recruitment',siteId:'1'}}]};
const next=structuredClone(old);next.primary_entry_url=next.primary_entry_url.replace('/1','/2');next.validated_api_request_examples[0].body.siteId='2';next.public_bootstrap_requests=[{url:next.primary_entry_url,method:'GET',purpose:'public_configuration_bootstrap'}];
const verification={identity:{accepted:true},kind:'public_redirect',mode:'campus',result:{coverage:{status:'partial',pages:1},jobs:[{job_id:'1',body_complete:true,formal_status:'formal',open_status:'open',official_url:'https://example.invalid/1'}]}};
test('automatic repair accepts bound parameters and rejects changes outside leaf whitelist',()=>{
 assertAutomaticRepair(old,next,verification);
 for(const field of ['company_id','source_id','provider','admitted','identity_verification','industry_tags','cities','project_type','api_config']){const bad={...next,[field]:'malicious'};assert.throws(()=>assertAutomaticRepair(old,bad,verification),/automatic_repair/);}
 for(const mutation of [s=>s.validated_api_request_examples[0].body.orgId='other',s=>s.validated_api_request_examples[0].body.region='US',s=>s.validated_api_request_examples[0].headers={Authorization:'secret'},s=>s.primary_entry_url=s.primary_entry_url.replace('/org/','/other/'),s=>s.primary_entry_url=s.primary_entry_url.replace('campus-recruitment','social-recruitment')]){const bad=structuredClone(next);mutation(bad);assert.throws(()=>assertAutomaticRepair(old,bad,verification),/automatic_repair/);}
 assert.throws(()=>assertAutomaticRepair(old,next,{...verification,mode:'social'}),/current_target/);
 assert.throws(()=>assertAutomaticRepair(old,next,{...verification,kind:'public_project_rotation'}),/binding/);
 assert.throws(()=>assertAutomaticRepair(old,next,{...verification,result:{jobs:[],coverage:{status:'complete',pages:1}}}),/full_jd/);
 const credentials=structuredClone(next);credentials.validated_api_request_examples[0].url=credentials.validated_api_request_examples[0].url.replace('https://','https://secret@');assert.throws(()=>assertAutomaticRepair(old,credentials,verification),/route/);
});
test('Feishu website-path repair preserves entry, tenant binding and request scope',()=>{
 const source={company_id:'f',provider:'feishu',primary_entry_url:'https://careers.example.invalid/',identity:{tenant_id:'known'},validated_api_request_examples:[{url:'https://careers.example.invalid/api/v1/search/job/posts',method:'POST',headers:{'website-path':'old'},body:{job_category_id_list:['social']}}]};
 const fixed=structuredClone(source);fixed.validated_api_request_examples[0].headers['website-path']='new';fixed.public_bootstrap_requests=[{url:source.primary_entry_url,method:'GET',purpose:'public_configuration_bootstrap'}];
 assertAutomaticRepair(source,fixed,{...verification,kind:'public_website_path_rotation'});
 for(const change of [s=>s.identity.tenant_id='other',s=>s.primary_entry_url+='other-project',s=>s.validated_api_request_examples[0].body.job_category_id_list=['campus']]){const bad=structuredClone(fixed);change(bad);assert.throws(()=>assertAutomaticRepair(source,bad,{...verification,kind:'public_website_path_rotation'}),/automatic_repair/);}
});
test('automatic repair archives complete evidence privately, refuses stale writes and supports guarded rollback',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'source-safe-')),file=path.join(dir,'registry.json'),initial={companies:[{...old,recruitment_sources:[old]}]};await fs.writeFile(file,JSON.stringify(initial));
 await assert.rejects(commitSourceRepair(old,next,{}, {registryFile:file}),/明确/);
 const r=await commitSourceRepair(old,next,{private_file:'D:/private/raw.json'},{registryFile:file,access:'safe_existing',verification});assert(r.updated);
 const publicText=await fs.readFile(file,'utf8');assert(!publicText.includes('D:/private'));assert(!publicText.includes('previous_config'));
 const record=JSON.parse(await fs.readFile(r.record,'utf8'));assert.equal(record.evidence.private_file,'D:/private/raw.json');assert(record.before_registry);
 const current=JSON.parse(publicText);assert.equal(current.companies[0].primary_entry_url,next.primary_entry_url);assert.equal(current.companies[0].recruitment_sources[0].repair_history[0].validation,'sample_only');
 assert.equal((await commitSourceRepair(old,next,{}, {registryFile:file,access:'safe_existing',verification})).reason,'configuration_changed_concurrently');
 await recoverSourceRepair(r.record,{registryFile:file,rollback:true});assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),initial);
 await recoverSourceRepair(r.record,{registryFile:file});current.companies[0].display_name='Changed by another writer';await fs.writeFile(file,JSON.stringify(current));await assert.rejects(recoverSourceRepair(r.record,{registryFile:file,rollback:true}),/已变化/);
});
