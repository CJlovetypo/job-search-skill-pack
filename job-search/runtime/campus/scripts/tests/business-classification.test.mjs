import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBusinessFilters,businessMatches,businessMatchMode,BUSINESS_TAXONOMY} from '../../../../../shared/job-search-core/scripts/lib/business-taxonomy.mjs';
import {classificationInputHash,validateClassification} from '../../../../../shared/job-search-core/scripts/lib/company-classification.mjs';
import {normalizeConfig,selectCompanies} from '../../../../../job-radar/scripts/radar.mjs';
import {decideTask,assertTaskExecution,assertScopeRevision,taskFingerprint} from '../../../../../shared/job-search-core/scripts/lib/task-decision.mjs';

test('business matching normalizes aliases and supports explicit any/all and parents',()=>{
 assert.deepEqual(normalizeBusinessFilters('游戏开发,游戏发行,游戏研发'),['游戏研发','游戏发行']);
 assert(businessMatches(['游戏研发'],['游戏']));
 assert(!businessMatches(['游戏开发工具'],['游戏']));
 assert(businessMatches(['游戏研发'],['游戏研发','游戏发行'],'any'));
 assert(!businessMatches(['游戏研发'],['游戏研发','游戏发行'],'all'));
 assert.throws(()=>normalizeBusinessFilters(['随意新造词']),/未识别/);
 assert.throws(()=>normalizeBusinessFilters(['待核实']),/不可筛选/);
 assert.throws(()=>businessMatchMode('oops'),/any\/all/);
});
function fixture(){
 const row={company_id:'a',identity:{display_name:'Synthetic'},tags:{industry:['internet'],business:['internet']},descriptions:{business_summary:'Synthetic研发并发行游戏。',products_services:'游戏研发、游戏发行'},governance:{fields:{'tags.business':{status:'demo_unreviewed'}}}};
 return {formal:{companies:[row]},manifest:{schema_version:1,method:'local_description_classification',taxonomy_version:BUSINESS_TAXONOMY.version,batch_id:'test',reviewer:'test',companies:[{company_id:'a',disposition:'change',reason:'direct subject',input_sha256:classificationInputHash(row),decisions:{'tags.business':{before:['internet'],value:['游戏研发','游戏发行'],kind:'semantic',reason:'Direct statement',citations:[{field:'descriptions.products_services',excerpt:'游戏研发、游戏发行'}]}}}]}};
}
test('classification rejects changed sources, invented citations, verified overrides and alias semantic changes',()=>{
 const good=fixture();assert.equal(validateClassification(good.manifest,good.formal).length,1);
 for(const mutate of [
  x=>x.formal.companies[0].descriptions.business_summary+=' changed',
  x=>x.manifest.companies[0].decisions['tags.business'].citations[0].excerpt='不存在的原句',
  x=>x.formal.companies[0].governance.fields['tags.business']={status:'verified',origin:'fresh_web_review'},
  x=>x.manifest.companies[0].decisions['tags.business'].kind='alias',
  x=>x.manifest.companies=[],
  x=>x.manifest.companies[0].decisions['tags.business'].value=['任意词']
 ]){const bad=fixture();mutate(bad);assert.throws(()=>validateClassification(bad.manifest,bad.formal));}
});
test('radar supports business-only target, any/all, old subscriptions and no matching company',()=>{
 const companies=[{company_id:'a',industry_tags:['internet'],business_tags:['游戏研发','游戏发行']},{company_id:'b',industry_tags:['internet'],business_tags:['游戏研发']},{company_id:'c',industry_tags:['smart_hardware'],business_tags:['游戏开发工具']}];
 const c=normalizeConfig({id:'games',mode:'social',business_filters:['游戏研发','游戏发行'],business_filter_match:'all'},companies);
 assert.deepEqual(selectCompanies(c,companies).map(x=>x.company_id),['a']);
 assert.equal(selectCompanies({...c,business_filter_match:'any'},companies).length,2);
 assert.equal(selectCompanies({mode:'social',company_ids:[],industries:['all']},companies).length,3);
 assert.equal(selectCompanies(normalizeConfig({...c,business_filters:['商业银行']},companies),companies).length,0);
});
test('business-only scope binds task execution and changing any/all requires a new run',()=>{
 const condition=value=>({state:'explicit',value,basis:'synthetic user request'});
 const task={schema_version:1,task_id:'business-test',revision:1,is_test:true,user_request:'合成：只看同时研发和发行游戏的社招公司',goal:'discover',conditions:{recruitment:condition('social'),businesses:{...condition(['游戏研发','游戏发行']),match:'all'}},retrieval:{mode:'exhaustive',selection:'explicit',basis:'synthetic'},materials:{profile:'not_needed'},issues:[],changes:[]};
 assert(decideTask(task).can_collect);
 const profile={is_test:true,industry_filters:['all'],business_filters:['游戏开发','游戏发行'],business_filter_match:'all'};
 assert.doesNotThrow(()=>assertTaskExecution(task,profile,'social',{discovery:true}));
 assert.throws(()=>assertTaskExecution(task,{...profile,business_filter_match:'any'},'social',{discovery:true}),/业务硬筛选/);
 const next=structuredClone(task);next.revision=2;next.supersedes={fingerprint:taskFingerprint(task)};next.conditions.businesses.match='any';
 assert.throws(()=>assertScopeRevision(task,next),/新运行/);
});
