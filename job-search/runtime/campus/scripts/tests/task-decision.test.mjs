import {MODE_ROOTS} from '../../../../scripts/runtime.mjs';
import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PACK_ROOT} from '../../../../../shared/job-search-core/runtime-context.mjs';
import {validateTask,decideTask,reviseTask,taskFingerprint,assertTaskExecution,assertTaskScope,assertScopeRevision} from '../../../../../shared/job-search-core/scripts/lib/task-decision.mjs';
import {sourceConfigFingerprint} from '../lib/source-collector.mjs';
import {readSourceRegistry} from '../../../../../shared/job-search-core/registry.mjs';
import {v5EligibilityFields} from '../../../../../shared/job-search-core/scripts/lib/search-mode.mjs';

const exec=promisify(execFile),entry=path.join(PACK_ROOT,'job-search/scripts/jobs.mjs');
const cli=(...args)=>exec(process.execPath,[entry,...args],{cwd:PACK_ROOT,windowsHide:true,maxBuffer:8e6,timeout:30000});
const condition=value=>({state:'explicit',value,basis:'模拟用户明确给出'});
function task(overrides={}){
 return {schema_version:1,task_id:'test-task',revision:1,is_test:true,user_request:'合成测试：找校招项目管理岗位，互联网行业，未指定城市',goal:'discover',
  conditions:{recruitment:condition('campus'),industries:condition(['internet']),roles:condition(['项目管理']),cities:{state:'unspecified',value:null}},
  retrieval:{mode:'exhaustive',selection:'explicit',basis:'合成用户已选择全量 JD 综合判断'},materials:{profile:'not_needed'},issues:[],changes:[],...overrides};
}
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2)+'\n','utf8');};

test('explicit campus, role and industry need no repeated questions; omitted city is not explicit unlimited',()=>{
 const result=decideTask(task());assert(result.can_collect);assert.equal(result.mode,'campus');assert.deepEqual(result.questions_now,[]);
 assert.equal(result.city_policy,'unrestricted_this_run_not_user_preference');assert.equal(result.retrieval,'exhaustive');assert.equal(result.can_assess,false);
 const other=task();other.conditions.cities=condition([]);assert.equal(decideTask(other).city_policy,'user_defined');assert.notEqual(taskFingerprint(other),taskFingerprint(task()));
});
test('discovery never requires a resume, salary or assessment scope',()=>{
 const result=decideTask(task({materials:{profile:'missing'}}));assert.equal(result.can_collect,true);assert.deepEqual(result.gates.collect,[]);assert.deepEqual(result.questions_now,[]);
});
test('salary and commute are acknowledged but never become execution blockers; soft cities are not hard filters',()=>{
 const value=task({goal:'match',materials:{profile:'missing',jd:'available'},evaluation_scope:condition({mode:'all'})});
 value.conditions.salary={state:'conflict',value:'25k且区间不明',basis:'用户要求'};
 value.conditions.commute=condition('半小时');value.issues=[{field:'commute',reason:'地址未知',question:'住哪里',blocks:['collect','assess']}];
 const result=decideTask(value);assert.equal(result.can_collect,true);assert.equal(result.can_review_partial,true);assert.equal(result.required_notices.length,2);assert(!result.questions_now.some(q=>['salary','commute'].includes(q.field)));
 value.conditions.cities={...condition(['上海']),importance:'prefer'};
 const p={assessment_model_version:5,is_test:true,evidence:[],industry_filters:['internet'],company_filters:[],city_filters:[],city_preference:{state:'explicit',values:['上海'],importance:'prefer'}};
 assert.doesNotThrow(()=>assertTaskExecution(value,p,'campus'));
 assert.throws(()=>assertTaskExecution(value,{...p,city_filters:['上海']},'campus'),/软偏好/);
});
test('industry omission is distinct from all, while exact companies define a finite scope',()=>{
 const value=task();delete value.conditions.industries;assert.deepEqual(decideTask(value).gates.collect,['industries']);
 value.conditions.companies=condition(['C']);assert.equal(decideTask(value).can_collect,true);
});
test('matching material and scope gaps block assessment but not independent collection',()=>{
 const value=task({goal:'match',materials:{profile:'missing'}}),result=decideTask(value);
 assert(result.can_collect);assert(!result.can_assess);assert(result.gates.assess.includes('profile'));assert(result.gates.assess.includes('evaluation_scope'));
 assert(!result.questions_now.some(q=>q.field==='evaluation_scope'));assert(result.questions_later.some(q=>q.field==='evaluation_scope'));
});
test('complete textual material and an explicit sample do not ask for a file or reconfirm the sample',()=>{
 const result=decideTask(task({goal:'match',materials:{profile:'available'},evaluation_scope:{...condition({mode:'sample',limit:20}),basis:'先评估20个'}}));
 assert.equal(result.can_collect,true);assert.equal(result.can_assess,false);assert(result.gates.assess.includes('jd_collection'));assert.deepEqual(result.questions_now,[]);assert.deepEqual(result.questions_later,[]);
 assert.equal(decideTask(task({goal:'match',materials:{profile:'available',jd:'available'},evaluation_scope:condition({mode:'sample',limit:20})})).can_assess,true);
});
test('ordinary role preference cannot silently select targeted retrieval',()=>{
 const value=task();value.retrieval={mode:'targeted',selection:'default',basis:'普通岗位倾向'};assert(validateTask(value).some(e=>e.includes('targeted')));
 value.retrieval.selection='explicit';value.retrieval.basis='用户说按标题快速定向';assert.deepEqual(validateTask(value),[]);
});
test('ambiguous goal blocks all dependent operations while allowing history reading',()=>{
 const result=decideTask(task({goal:'clarify',conditions:{}}));assert.equal(result.can_collect,false);
 for(const gate of Object.values(result.gates))assert(gate.includes('goal'));
 assert(result.independent_actions.includes('read_available_materials_and_history'));
});
test('PM ambiguity is an issue, not silently resolved by keyword matching',()=>{
 const result=decideTask(task({issues:[{field:'role',reason:'PM有两种含义',question:'产品经理还是项目经理？',blocks:['collect','assess']}]}));
 assert.equal(result.can_collect,false);assert.equal(result.questions_now[0].field,'role');
});
test('explicit unknown/unspecified values cannot carry invented facts',()=>{
 const value=task();value.conditions.cities.value=['上海'];assert(validateTask(value).some(e=>e.includes('未指定')));
 value.conditions.cities=condition(['上海','上海']);assert(validateTask(value).some(e=>e.includes('不重复')));
});
test('only high value first-turn questions are shown, scope is deferred',()=>{
 const result=decideTask(task({goal:'match',conditions:{},materials:{profile:'missing'},issues:[{field:'material_conflict',reason:'两份冲突',question:'核对时间线？',blocks:['assess']}]}));
 assert.equal(result.questions_now.length,3);assert(result.questions_later.length>=2);
});
test('radar role-only targeting asks scope but not resume, cities, or a known schedule',()=>{
 const result=decideTask(task({goal:'radar',radar_action:'create',conditions:{recruitment:condition('social'),roles:condition(['数据分析']),schedule:condition({time:'09:00',timezone:'Asia/Shanghai'})},materials:{profile:'not_needed'}}));
 assert.deepEqual(result.questions_now.map(q=>q.field),['industries']);assert.deepEqual(result.gates.schedule,['industries']);assert.equal(result.route,'job-radar');
 assert.equal(result.can_collect,false);
 const ready=decideTask(task({goal:'radar',radar_action:'create',conditions:{recruitment:condition('social'),industries:condition(['all']),roles:condition(['数据分析']),schedule:condition({time:'09:00',timezone:'Asia/Shanghai'})},materials:{profile:'not_needed'}}));
 assert.equal(ready.can_collect,true);assert.deepEqual(ready.gates.schedule,[]);
});
test('radar pause/mute/history does not demand search criteria again',()=>{
 for(const action of ['pause','mute','history']){
  const result=decideTask(task({goal:'radar',radar_action:action,subscription_id:'existing',conditions:{}}));assert.deepEqual(result.questions_now,[]);
 }
 const result=decideTask(task({goal:'radar',radar_action:'pause',conditions:{}}));assert.deepEqual(result.questions_now.map(q=>q.field),['subscription']);
});
test('repair only needs target identity and preserves read-only access',()=>{
 const value=task({goal:'repair',repair_access:'read_only',conditions:{repair_target:condition('company-or-url')}});
 assert.deepEqual(decideTask(value).questions_now,[]);assert.equal(value.repair_access,'read_only');
});
test('specific JD comparison does not demand industry selection',()=>{
 const result=decideTask(task({goal:'compare',conditions:{recruitment:condition('campus')},materials:{profile:'available',jd:'missing'},evaluation_scope:condition({mode:'all'})}));
 assert.deepEqual(result.questions_now.map(q=>q.field),['jd']);
});
test('eligibility consultation answers the question without asking for a market-search scope',()=>{
 const result=decideTask(task({goal:'consult',conditions:{},materials:{profile:'partial',jd:'missing'}}));
 assert.deepEqual(result.questions_now,[]);assert.equal(result.can_collect,false);assert.equal(result.can_assess,false);
});
test('scope promise rejects hidden sample changes and first-N sampling substitutions',()=>{
 const value=task({goal:'match',evaluation_scope:condition({mode:'sample',limit:20,selection:'display_order'})});
 assert.throws(()=>assertTaskScope(value,{mode:'sample',limit:10}),/数量/);
 assert.throws(()=>assertTaskScope(value,{mode:'all'}),/范围/);
 assert.throws(()=>assertTaskScope(value,{mode:'sample',limit:20}),/固定岗位键/);
 assert.doesNotThrow(()=>assertTaskScope(value,{mode:'sample',limit:20,jobs:[{company_id:'C',job_id:'J'}],candidateCount:1}));
 value.evaluation_scope.value.selection='rank_after_assessment';assert(validateTask(value).some(e=>e.includes('排名')));
});
test('sample job lists cannot silently underfill an available pool or narrow companies',()=>{
 const value=task({goal:'match',evaluation_scope:condition({mode:'sample',limit:2})}),jobs=[{company_id:'A',job_id:'1'}];
 assert.throws(()=>assertTaskScope(value,{mode:'sample',limit:2,jobs,candidateCount:6}),/数量/);
 assert.doesNotThrow(()=>assertTaskScope(value,{mode:'sample',limit:2,jobs,candidateCount:1}));
 assert.throws(()=>assertTaskScope(value,{mode:'sample',limit:2,companyIds:['A']}),/公司/);
 value.evaluation_scope.value.companies=['A'];
 assert.doesNotThrow(()=>assertTaskScope(value,{mode:'sample',limit:2,companyIds:['A']}));
 assert.throws(()=>assertTaskScope(value,{mode:'sample',limit:2,companyIds:['B']}),/公司/);
});
test('scope revision treats object key order as serialization and still rejects changed materials',()=>{
 const previous=task({materials:{profile:'available',jd:'missing'}});
 const next=reviseTask(previous,{task_id:previous.task_id,revision:2,user_request:'先抽2个',evaluation_scope:condition({mode:'sample',limit:2}),changes:['scope']});
 next.materials={jd:'missing',profile:'available'};
 assert.doesNotThrow(()=>assertScopeRevision(previous,next));
 next.materials.profile='missing';assert.throws(()=>assertScopeRevision(previous,next),/新运行/);
});
test('a revision inherits facts without overwriting prior state, and records what needs reassessment',()=>{
 const previous=task({goal:'match',materials:{profile:'available'},evaluation_scope:condition({mode:'sample',limit:20})}),before=JSON.stringify(previous);
 const next=reviseTask(previous,{task_id:previous.task_id,revision:2,user_request:'杭州也加上',conditions:{cities:condition(['上海','杭州'])},changes:['cities']});
 assert.equal(JSON.stringify(previous),before);assert.equal(next.conditions.recruitment.state,'inherited');assert.equal(next.evaluation_scope.value.limit,20);
 assert.equal(next.supersedes.fingerprint,taskFingerprint(previous));assert(decideTask(next).change_actions.includes('new_run_extend_scope_reuse_valid_jd'));
 const preference=reviseTask(next,{task_id:next.task_id,revision:3,user_request:'销售也能接受',changes:['preference']});
 assert(decideTask(preference).change_actions.includes('invalidate_assessments_reuse_unchanged_facts'));
 assert.throws(()=>reviseTask(previous,{task_id:'other',revision:2}),/相同/);
});
test('refresh, direction switch and presentation have distinct actions',()=>{
 assert(decideTask(task({changes:['refresh']})).change_actions.includes('refresh_jobs'));
 assert(decideTask(task({changes:['recruitment']})).change_actions.includes('new_direction_runtime_verify_direction_and_cities'));
 assert.deepEqual(decideTask(task({changes:['presentation']})).change_actions,['render_existing_valid_assessments']);
});
test('unresolved questions survive unrelated revisions; preference changes cannot bypass reassessment via scope command',()=>{
 const previous=task({issues:[{field:'role',reason:'目标含糊',question:'什么职能？',blocks:['collect']}]}),next=reviseTask(previous,{task_id:previous.task_id,revision:2,user_request:'换上海',conditions:{cities:condition(['上海'])},changes:['cities']});
 assert.deepEqual(next.issues,previous.issues);assert(decideTask(next).gates.collect.includes('role'));
 assert.throws(()=>assertScopeRevision(previous,next),/新运行/);
 const preference=reviseTask(previous,{task_id:previous.task_id,revision:2,user_request:'我接受销售',conditions:{roles:condition(['销售'])},changes:['scope']});
 assert.throws(()=>assertScopeRevision(previous,preference),/新运行/);
});
test('execution inputs cannot drift from declared direction, city, companies, strategy or test status',()=>{
 const profile={is_test:true,industry_filters:['internet'],city_filters:[]};
 assert.doesNotThrow(()=>assertTaskExecution(task(),profile,'campus',{discovery:true}));
 assert.throws(()=>assertTaskExecution(task(),profile,'social',{discovery:true}),/方向/);
 assert.throws(()=>assertTaskExecution(task(),{...profile,city_filters:['上海']},'campus',{discovery:true}),/城市/);
 assert.throws(()=>assertTaskExecution(task(),{...profile,company_filters:['hidden']},'campus',{discovery:true}),/公司/);
 assert.throws(()=>assertTaskExecution(task(),profile,'campus',{discovery:true,searchPlan:{}}),/策略/);
 assert.throws(()=>assertTaskExecution(task(),{...profile,is_test:false},'campus',{discovery:true}),/is_test/);
});
test('unified CLI never defaults an actionable request to campus and requires task on prepare',async()=>{
 await assert.rejects(cli('catalog'),e=>/明确 --mode/.test(e.stderr));
 await assert.rejects(cli('prepare','--mode','campus'),e=>/需要 --task/.test(e.stderr));
 const result=JSON.parse((await cli('industries')).stdout);assert(result.all_companies>0);
});
test('task saving is immutable and a declared revision can be read back',async()=>{
 const dir=path.join(PACK_ROOT,'job-search/runs','contract-'+randomUUID()),input=path.join(dir,'input.json'),out=path.join(dir,'r1.json');await write(input,task());
 await cli('task-save','--file',input,'--out',out);await assert.rejects(cli('task-save','--file',input,'--out',out),e=>/EEXIST/.test(e.stderr));
 const patch=path.join(dir,'patch.json');await write(patch,{task_id:'test-task',revision:2,user_request:'改成社招',conditions:{recruitment:condition('social')},changes:['recruitment']});
 const out2=path.join(dir,'r2.json');await cli('task-save','--file',patch,'--previous',out,'--out',out2);
 const result=JSON.parse((await cli('task-show','--file',out2)).stdout);assert.equal(result.decision.mode,'social');assert.equal(result.task.conditions.industries.state,'inherited');
});

for(const mode of ['campus','internship','social'])test(`real ${mode} CLI: discovery prepare, cached collect, report, no fabricated profile or personal assessment`,async()=>{
 const source=(await readSourceRegistry()).companies[0],root=path.join(PACK_ROOT,MODE_ROOTS[mode]),dir=path.join(root,'runs','discovery-test-'+randomUUID());
 const input=path.join(dir,'input.json'),record=path.join(dir,'task.json');
 const query={is_test:true,industry_filters:['all'],company_filters:[source.company_id],city_filters:[]};
 const t=task({conditions:{recruitment:condition(mode),companies:condition([source.company_id]),industries:condition(['all']),roles:condition(['项目管理'])}});
 await write(input,query);await write(record,t);
 await cli('prepare','--mode',mode,'--discovery','--profile',input,'--task',record,'--out',dir);
 const run=JSON.parse(await fs.readFile(path.join(dir,'run.json'),'utf8'));assert.equal(run.purpose,'discover');assert.equal(run.profile.evidence,undefined);assert.equal(run.task_fingerprint,taskFingerprint(t));
 const snapshot={company_id:source.company_id,checked_at:'2026-09-22T00:00:00Z',source_config_fingerprint:sourceConfigFingerprint(source,mode),coverage:{status:'complete',collection_complete:true,pages:1,jobs_observed:2,reason:'离线合成快照'},requests:[],counts:{total:2,to_assess:1,needs_verification:1},jobs:[
  {job_id:'test-1',company_id:source.company_id,title:'项目管理（合成）',description:'负责项目进度跟踪和跨部门协调。',requirements:'具有沟通能力和项目实践。',body_complete:true,formal_status:mode==='campus'?'formal':mode,open_status:'open',cities:['上海'],city_status:'included',evaluation_status:'to_assess',official_url:'https://example.invalid/jobs/1'},
  {job_id:'test-2',company_id:source.company_id,title:'待核实（合成）',description:'缺要求',requirements:'',body_complete:false,formal_status:'unknown',open_status:'unknown',cities:[],city_status:'unknown',evaluation_status:'needs_verification',official_url:'javascript:bad()'}]};
 await write(path.join(dir,'companies',source.company_id+'.json'),snapshot);
 const collected=JSON.parse((await cli('collect','--mode',mode,'--run',dir)).stdout.trim().split('\n').at(-1));assert.match(collected.next_step,/role-review-export/);assert.equal(collected.role_review_pending,2);
 const report=JSON.parse((await cli('render-discovery','--mode',mode,'--run',dir)).stdout),result=JSON.parse(await fs.readFile(report.json,'utf8'));
 assert.equal(result.jobs.length,2);assert(result.jobs.every(j=>j.assessment_status==='not_assessed'));assert.equal(result.jobs[1].url,null);assert.equal(result.coverage[0].checked_at,snapshot.checked_at);
 assert.match(await fs.readFile(report.markdown,'utf8'),/尚未进行个人匹配/);
 for(const command of ['batch-create','plan-assessment','render'])await assert.rejects(cli(command,'--mode',mode,'--run',dir),e=>/岗位发现未做个人匹配/.test(e.stderr));
 const request=JSON.parse((await cli('role-review-export','--mode',mode,'--run',dir)).stdout);
 const submission=path.join(dir,'roles.json');await write(submission,{items:request.items.map(r=>({...r,status:r.body_complete?'related':'uncertain',reason:r.body_complete?'职责体现项目协调。':'正文不足，不能否定相关性。',evidence:r.body_complete?[r.description]:[]}))});
 const reviewed=JSON.parse((await cli('role-review-submit','--mode',mode,'--run',dir,'--file',submission)).stdout);assert.equal(reviewed.pending,0);
 // Snapshot tampering must fail before another collection can run.
 const mutated=JSON.parse(await fs.readFile(path.join(dir,'run.json'),'utf8'));mutated.task_snapshot.user_request+=' changed';await write(path.join(dir,'run.json'),mutated);
 await assert.rejects(cli('collect','--mode',mode,'--run',dir),e=>/快照已变化/.test(e.stderr));
});

test('all new policy links resolve and entrypoints stay discoverable',async()=>{
 const files=['job-search/SKILL.md',...['decision-policy','search-strategy','matching-model','delivery','task-contract'].map(x=>'shared/job-search-core/references/'+x+'.md'),...['campus','social','internship'].map(x=>'shared/job-search-core/references/modes/'+x+'.md')];
 for(const rel of files){const file=path.join(PACK_ROOT,rel),source=await fs.readFile(file,'utf8');for(const m of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g))if(!/^https?:/.test(m[1]))await fs.access(path.resolve(path.dirname(file),m[1].split('#')[0]));}
});

for(const mode of ['campus','internship','social'])test(`real ${mode} unified CLI: empty profile completes v5 collect, batch submission, merge and Excel delivery`,async()=>{
 const source=(await readSourceRegistry()).companies[0],dir=path.join(PACK_ROOT,MODE_ROOTS[mode],'runs','v5-empty-'+randomUUID());
 const input=path.join(dir,'input.json'),record=path.join(dir,'task.json');
 await write(input,{is_test:true,industry_filters:['all'],company_filters:[source.company_id],city_filters:[]});
 const taskValue=task({goal:'match',conditions:{recruitment:condition(mode),companies:condition([source.company_id]),industries:condition(['all'])},materials:{profile:'missing'},evaluation_scope:condition({mode:'all'})});await write(record,taskValue);
 await cli('prepare','--mode',mode,'--profile',input,'--task',record,'--out',dir);
 const run=JSON.parse(await fs.readFile(path.join(dir,'run.json'),'utf8'));assert.equal(run.profile.assessment_model_version,5);assert.deepEqual(run.profile.evidence,[]);assert.equal(run.profile.degree,undefined);assert.equal(run.profile.city_preference.state,'unspecified');
 await write(path.join(dir,'companies',source.company_id+'.json'),{source_config_fingerprint:sourceConfigFingerprint(source,mode),coverage:{status:'complete',collection_complete:true},checked_at:'2026-09-22',jobs:[{job_id:'J1',company_id:source.company_id,title:'合成岗位',description:'跟踪进度',requirements:'本科',formal_status:mode==='campus'?'formal':mode,open_status:'open',body_complete:true,cities:['上海'],evaluation_status:'to_assess'}]});
 await cli('collect','--mode',mode,'--run',dir);
 await cli('plan-assessment','--mode',mode,'--run',dir);
 const batch=JSON.parse((await cli('batch-create','--mode',mode,'--run',dir)).stdout),fixed=JSON.parse(await fs.readFile(batch.input,'utf8'));assert.equal(batch.items,1);assert.deepEqual(fixed.profile.evidence,[]);assert.match(fixed.assessment_instruction,/unknown/);
 const review={review_method:'full_jd',ability:'unknown',ability_reason:'未提供本人进度跟踪实践。',interest:'unknown',interest_reason:'未提供工作内容偏好。',interest_checks:[],
  eligibility:'unknown',eligibility_reason:'岗位要求本科，本人学历未知。',eligibility_checks:v5EligibilityFields(mode).map(field=>({field,status:field==='degree'?'unknown':'not_stated',jd_requirement:field==='degree'?'本科':'JD未要求',candidate_fact:'本人未提供'})),
  next_action:'clarify',conclusion:'信息待确认。',next_step:'补充本人学历和进度跟踪案例。',
  comparisons:[{jd_requirement:'跟踪进度',requirement_type:'core',status:'unknown',support:'unsupported',evidence_strength:'none',profile_evidence_ids:[],explanation:'未提供经历，不能推断不具备能力。',gap:'本人行动及成果'}],
  city_check:{status:'unspecified',importance:'open',user_basis:'没有指定城市',job_basis:'岗位在上海'},
  salary_check:{status:'not_specified',raw:'',reason:'JD未披露，仅供参考',user_basis:'用户未指定',job_basis:'JD未披露'},
  evidence_sufficiency:{status:'insufficient',reason:'学历和实际任务经历未知',missing:['学历','任务经历']},
  report_summary:{conclusion:'补资料后判断。',ability:'实际任务经历未知。',interest:'工作内容偏好未知。',gaps:'补充学历和任务经历。'}};
 const common=['--mode',mode,'--run',dir,'--batch',batch.batch_id];
 await cli('batch-start',...common,'--agent','unified-test');
 const draft=path.join(dir,'draft.json');await write(draft,{items:[{key:fixed.items[0].key,review}]});
 const submitted=JSON.parse((await cli('batch-submit',...common,'--agent','unified-test','--file',draft)).stdout);assert.deepEqual(submitted.errors,{});
 assert.equal(JSON.parse((await cli('batch-merge',...common)).stdout).added,1);
 await cli('batch-close',...common,'--agent','unified-test','--stopped');
 const rendered=JSON.parse((await cli('render','--mode',mode,'--run',dir)).stdout.trim().split('\n').at(-1));
 assert.equal(rendered.complete_evaluation_scope,true);assert.equal(rendered.assessed,1);
 assert.equal((await fs.readFile(rendered.workbook)).subarray(0,2).toString(),'PK');
 assert(rendered.workbook.startsWith(path.join(PACK_ROOT,MODE_ROOTS[mode],'outputs')));
 const audit=JSON.parse(await fs.readFile(path.join(dir,'report-audit.json'),'utf8'));assert.equal(audit.reviewed_with_uncertainty,1);
 assert.equal(JSON.parse((await cli('batch-create','--mode',mode,'--run',dir)).stdout).items,0);
 await cli('company-profiles','--mode',mode,'status');
});

test('new matching CLI binds scope and accepts only a continuous scope revision without losing old tasks',async()=>{
 const source=(await readSourceRegistry()).companies[0],dir=path.join(PACK_ROOT,'job-search/runtime/campus/runs','scope-task-'+randomUUID());
 const profile={is_test:true,degree:'本科',graduation:'2027-06',industry_filters:['all'],company_filters:[source.company_id],city_filters:[],
  evidence:[{id:'E1',text:'合成学生项目中独立完成排期与风险记录',source:'测试文本',kind:'self_description',claim_type:'objective_experience',experience_type:'course_project',experience_id:'EXP1'}]};
 const record=task({goal:'match',conditions:{recruitment:condition('campus'),industries:condition(['all']),companies:condition([source.company_id])},materials:{profile:'available'},evaluation_scope:condition({mode:'sample',limit:2})});
 const p=path.join(dir,'profile.json'),t=path.join(dir,'task.json');await write(p,profile);await write(t,record);
 await cli('prepare','--mode','campus','--profile',p,'--task',t,'--out',dir);
 const snapshot={source_config_fingerprint:sourceConfigFingerprint(source,'campus'),coverage:{status:'complete'},jobs:['J1','J2'].map(job_id=>({job_id,title:'合成项目',evaluation_status:'to_assess'}))};
 await write(path.join(dir,'companies',source.company_id+'.json'),snapshot);
 await assert.rejects(cli('plan-assessment','--mode','campus','--run',dir,'--scope-mode','sample','--limit','3'),e=>/数量/.test(e.stderr));
 const shortList=path.join(dir,'short-jobs.json');await write(shortList,[{company_id:source.company_id,job_id:'J1'}]);
 await assert.rejects(cli('plan-assessment','--mode','campus','--run',dir,'--jobs',shortList),e=>/数量/.test(e.stderr));
 await assert.rejects(fs.access(path.join(dir,'evaluation-scope.json')));
 const scope=JSON.parse((await cli('plan-assessment','--mode','campus','--run',dir)).stdout);assert.equal(scope.sample_limit,2);assert.equal(scope.selected_jobs_at_confirmation,2);
 await write(path.join(dir,'companies',source.company_id+'.json'),{...snapshot,jobs:snapshot.jobs.slice(0,1)});
 const smallPool=JSON.parse((await cli('plan-assessment','--mode','campus','--run',dir,'--jobs',shortList)).stdout);assert.equal(smallPool.selected_jobs_at_confirmation,1);assert.equal(smallPool.total_jobs_at_confirmation,1);
 const revised=reviseTask(record,{task_id:record.task_id,revision:2,user_request:'剩下全部评完',evaluation_scope:condition({mode:'all'}),changes:['scope']}),t2=path.join(dir,'task-r2.json');await write(t2,revised);
 const all=JSON.parse((await cli('plan-assessment','--mode','campus','--run',dir,'--task',t2)).stdout);assert.equal(all.mode,'all');
 const run=JSON.parse(await fs.readFile(path.join(dir,'run.json'),'utf8'));assert.equal(run.task_snapshot.revision,2);assert.equal(run.task_history[0].revision,1);
});

test('role intent without a retrieval choice blocks dependent work and explains both options',()=>{
 for(const goal of ['discover','match','explore']){
  const value=task({goal,retrieval:{mode:'exhaustive',selection:'default',basis:'尚未选择'},materials:{profile:'available',jd:'available'},evaluation_scope:condition({mode:'all'})});
  const result=decideTask(value);assert.equal(result.can_collect,false);assert.equal(result.can_assess,false);
  assert(result.gates.collect.includes('retrieval'));assert(result.gates.assess.includes('retrieval'));
  assert.throws(()=>assertTaskExecution(value,{assessment_model_version:5},'campus',{discovery:goal==='discover'}),/采集前须解决.*retrieval/);
  const question=result.questions_now.find(q=>q.field==='retrieval');assert.match(question.question,/更快.*漏掉/);assert.match(question.question,/覆盖更充分.*耗时/);
  assert(result.independent_actions.includes('read_available_materials_and_history'));
  for(const mode of ['exhaustive','targeted'])for(const selection of ['explicit','inherited']){
   const chosen=decideTask({...value,retrieval:{mode,selection,basis:'用户选择或可定位的既有选择'}});assert(chosen.can_collect);assert(!chosen.questions_now.some(q=>q.field==='retrieval'));
  }
  value.conditions.roles={state:'unspecified',value:null};assert(decideTask(value).can_collect);
  value.conditions.roles=condition([]);assert(decideTask(value).can_collect);
 }
});
