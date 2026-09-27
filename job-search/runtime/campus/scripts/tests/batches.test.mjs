import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {SKILL_ROOT,readJson,writeJson} from '../lib/io.mjs';
import {createBatch,startBatch,submitBatch,mergeBatch,closeBatch,batchStatus,readTokenUsage} from '../lib/batches.mjs';

async function fixture(count=4) {
  const parent=path.join(SKILL_ROOT,'tmp','batch-tests');await fs.mkdir(parent,{recursive:true});
  const dir=await fs.mkdtemp(path.join(parent,'run-'));
  const profile={graduation:'2027-03',degree:'硕士',evidence:[{id:'E1',text:'测试项目管理实习：负责排期。',claim_type:'objective_experience',experience_type:'internship',experience_id:'EXP1',kind:'resume',source:'合成测试'}]};
  const companies=['alpha','beta'].map(company_id=>({company_id,display_name:company_id,selected:true}));
  await writeJson(path.join(dir,'run.json'),{profile,companies});
  for(const c of companies)await writeJson(path.join(dir,'companies',c.company_id+'.json'),{jobs:Array.from({length:count},(_,i)=>({company_id:c.company_id,job_id:String(i),title:'算法工程师 '+i,description:'负责三维重建算法研发。',requirements:'硕士，3DGS、NeRF 实现。',recruitment_evidence:{hireMode:2},evaluation_status:'to_assess',body_complete:true,formal_status:'formal',open_status:'open'}))});
  await writeJson(path.join(dir,'evaluation-scope.json'),{mode:'all',confirmed_at:'2026-09-13',company_ids:['alpha','beta'],user_request:'合成测试全量'});
  return dir;
}
function judgment() {
  return {review_method:'full_jd',ability:'low',ability_reason:'未提供三维重建研究或实现证据。',interest:'conflict',interest_reason:'用户目标为项目管理，算法岗不符合职能。',interest_checks:[{preference:'项目管理',importance:'prefer',status:'conflict',user_basis:'合成用户选择项目管理',job_basis:'JD主要为算法实现'}],eligibility:'eligible',eligibility_reason:'2027年硕士，未发现届别和学历冲突。',next_action:'hold',conclusion:'核心算法证据不足，暂不建议投递。',next_step:'优先项目管理岗位。',comparisons:[{jd_requirement:'三维重建算法实现',requirement_type:'core',support:'unsupported',evidence_strength:'none',profile_evidence_ids:[],explanation:'未提供相关算法成果。',gap:'算法研发证据'}],report_summary:{conclusion:'暂不建议投递。',ability:'缺少三维重建算法实践。',interest:'职能不符合项目管理目标。',gaps:'缺少算法成果。'}};
}
async function prepare(dir,limit=2,agent='worker') {
  const batch=await createBatch(dir,{limit});await startBatch(dir,batch.batch_id,agent);
  const input=await readJson(batch.input);
  return {...batch,input,items:input.items.map(i=>({key:i.key,review:judgment()})),agent};
}

test('固定输入独立于 next-batch 和源数组顺序；跨公司相同 job_id 不混淆',async()=>{
  const dir=await fixture(2),a=await prepare(dir,2,'a'),b=await prepare(dir,2,'b');
  assert.equal(new Set([...a.items,...b.items].map(i=>i.key)).size,4);
  await writeJson(path.join(dir,'next-batch.json'),{pending:[{job:{job_id:'wrong'}}]});
  for(const cid of ['alpha','beta']){const f=path.join(dir,'companies',cid+'.json'),data=await readJson(f);data.jobs.reverse();await writeJson(f,data);}
  await submitBatch(dir,a.batch_id,'a',a.items);await submitBatch(dir,b.batch_id,'b',b.items);
  assert.equal((await mergeBatch(dir,a.batch_id)).added,2);assert.equal((await mergeBatch(dir,b.batch_id)).added,2);
  for(const cid of ['alpha','beta']){const r=await readJson(path.join(dir,'assessments',cid+'.json'));assert.deepEqual(r.assessments.map(x=>x.job_id),['0','1']);assert.ok(r.assessments.every(x=>x.priority==='low'));}
  assert.equal((await batchStatus(dir)).done,4);
});
test('缺失字段集中返回，合法岗位可提交；半文件不被合并',async()=>{
  const dir=await fixture(),b=await prepare(dir);delete b.items[1].review.report_summary;delete b.items[1].review.next_step;
  const submitted=await submitBatch(dir,b.batch_id,b.agent,b.items);
  assert.equal(submitted.accepted,1);assert.ok(submitted.errors[b.items[1].key].length>=5);
  await fs.writeFile(path.join(path.dirname(submitted.submission),'unfinished.json.tmp'),'{');
  assert.equal((await mergeBatch(dir,b.batch_id)).added,1);
  await submitBatch(dir,b.batch_id,b.agent,[{key:b.items[1].key,review:judgment()}]);
  assert.equal((await mergeBatch(dir,b.batch_id)).added,1);
  assert.deepEqual((await mergeBatch(dir,b.batch_id)).errors,{});
});
test('重复提交幂等；不同结论禁止静默覆盖',async()=>{
  const dir=await fixture(),b=await prepare(dir,1);
  await submitBatch(dir,b.batch_id,b.agent,b.items);await submitBatch(dir,b.batch_id,b.agent,b.items);
  assert.equal((await mergeBatch(dir,b.batch_id)).added,1);assert.equal((await mergeBatch(dir,b.batch_id)).added,0);
  b.items[0].review.conclusion='另一份不同的结论';await submitBatch(dir,b.batch_id,b.agent,b.items);
  await assert.rejects(()=>mergeBatch(dir,b.batch_id),/不同提交/);
  assert.equal((await readJson(path.join(dir,'assessments/alpha.json'))).assessments[0].conclusion,'核心算法证据不足，暂不建议投递。');
});
test('中断后只释放未合并岗位；旧执行者与迟到结果不能覆盖新任务',async()=>{
  const dir=await fixture(),b=await prepare(dir,2);
  await assert.rejects(()=>startBatch(dir,b.batch_id,'other'),/其他执行者/);
  await submitBatch(dir,b.batch_id,b.agent,b.items.slice(0,1));await mergeBatch(dir,b.batch_id);
  await assert.rejects(()=>closeBatch(dir,b.batch_id,{agentId:b.agent}),/先关闭/);
  const closed=await closeBatch(dir,b.batch_id,{agentId:b.agent,stopped:true});
  assert.equal(closed.returned_valid,1);assert.equal(closed.merged,1);
  const next=await prepare(dir,1,'new');assert.equal(next.items[0].key,b.items[1].key);
  await assert.rejects(()=>submitBatch(dir,b.batch_id,b.agent,b.items),/已关闭/);
  await assert.rejects(()=>mergeBatch(dir,b.batch_id),/已经关闭/);
});
test('外来身份、越界岗位、JD修改与正式记录变更不能被接受',async()=>{
  const dir=await fixture(),b=await prepare(dir,1);
  const forged=structuredClone(b.items);forged[0].review.job_id='other';
  assert.equal((await submitBatch(dir,b.batch_id,b.agent,forged)).accepted,0);
  await assert.rejects(()=>submitBatch(dir,b.batch_id,b.agent,[{key:'other',review:judgment()}]),/不属于/);
  await submitBatch(dir,b.batch_id,b.agent,b.items);
  const f=path.join(dir,'companies/alpha.json'),source=await readJson(f);source.jobs[0].requirements='changed';await writeJson(f,source);
  await assert.rejects(()=>mergeBatch(dir,b.batch_id),/快照已变化/);
});
test('修改固定输入拒绝继续；容量只缩小数量，不截断长正文',async()=>{
  const dir=await fixture(),b=await createBatch(dir,{limit:50,maxChars:1000});
  assert.ok(b.items<8);const input=await readJson(b.input);assert.ok(input.items.every(i=>i.job.requirements==='硕士，3DGS、NeRF 实现。'));
  input.items[0].job.title='wrong';await writeJson(b.input,input);await assert.rejects(()=>startBatch(dir,b.batch_id,'x'),/固定输入被修改/);
});
test('合并中断发生在公司文件写入后，可重放恢复而不重复计数',async()=>{
  const dir=await fixture(),b=await prepare(dir,2);await submitBatch(dir,b.batch_id,b.agent,b.items);
  const f=path.join(dir,'parallel/batches/state.json'),before=await readJson(f);
  await mergeBatch(dir,b.batch_id);await writeJson(f,before);
  assert.equal((await mergeBatch(dir,b.batch_id)).added,2);
  assert.equal((await readJson(path.join(dir,'assessments/alpha.json'))).assessments.length,2);
  assert.equal((await batchStatus(dir)).done,2);
});
test('token累计不叠加，扣除继承基线，保留缓存与推理子项',async()=>{
  const dir=await fixture(),f=path.join(dir,'tokens.jsonl');
  const e=(input,output,lastInput,lastOutput)=>({timestamp:'2026-09-13T00:00:00Z',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:output,cached_input_tokens:0,total_tokens:input+output},last_token_usage:{input_tokens:lastInput,output_tokens:lastOutput,cached_input_tokens:0,total_tokens:lastInput+lastOutput}}}});
  await fs.writeFile(f,[e(110,11,10,1),e(140,14,30,3),e(140,14,30,3)].map(JSON.stringify).join('\n'));
  const r=await readTokenUsage(f);assert.equal(r.input_tokens,40);assert.equal(r.output_tokens,4);assert.equal(r.total_tokens,44);assert.equal(r.reasoning_output_tokens,null);
});

test('外部修改或删除正式记录时拒绝覆盖，不改动外部结果',async()=>{
  for(const remove of [false,true]){
    const dir=await fixture(1),b=await prepare(dir,1);
    await submitBatch(dir,b.batch_id,b.agent,b.items);await mergeBatch(dir,b.batch_id);
    const file=path.join(dir,'assessments/alpha.json'),data=await readJson(file);
    if(remove)data.assessments=[];else data.assessments[0].conclusion='外部人工复核';
    await writeJson(file,data);
    await assert.rejects(()=>mergeBatch(dir,b.batch_id),/其他执行者修改/);
    assert.deepEqual(await readJson(file),data);
  }
});

test('范围定向领取、并发上限、真实工具计时和画像隔离',async()=>{
  const dir=await fixture(2),key=JSON.stringify(['beta','1']);
  await assert.rejects(()=>createBatch(dir,{keys:['outside']}),/属于本次范围/);
  const b=await createBatch(dir,{keys:[key],concurrency:1});
  assert.deepEqual((await readJson(b.input)).items.map(i=>i.key),[key]);
  await assert.rejects(()=>createBatch(dir,{concurrency:1}),/槽位已满/);
  const timing={toolStartedAt:'2026-09-13T00:00:00Z',toolFinishedAt:'2026-09-13T00:00:01Z'};
  await startBatch(dir,b.batch_id,'worker',timing);
  await closeBatch(dir,b.batch_id,{agentId:'worker',stopped:true,...timing});
  const status=await batchStatus(dir);assert.equal(status.batches[0].dispatch_ms,1000);assert.equal(status.batches[0].shutdown_ms,1000);
  const file=path.join(dir,'run.json'),run=await readJson(file);run.profile.evidence[0].text='画像新事实';await writeJson(file,run);
  await assert.rejects(()=>createBatch(dir),/画像已变更/);
});

test('已关闭后扩范围保留完成结果；采集标记只刷新一次',async()=>{
  const dir=await fixture(1),file=path.join(dir,'evaluation-scope.json');
  await writeJson(file,{mode:'companies',company_ids:['alpha'],confirmed_at:'2026-09-13',user_request:'仅alpha'});
  const b=await prepare(dir,1);await submitBatch(dir,b.batch_id,b.agent,b.items);await mergeBatch(dir,b.batch_id);
  await closeBatch(dir,b.batch_id,{agentId:b.agent,stopped:true});
  await writeJson(file,{mode:'companies',company_ids:['alpha','beta'],confirmed_at:'2026-09-13',user_request:'扩大到beta'});
  const next=await createBatch(dir,{limit:10});assert.equal(next.items,1);
  assert.equal((await batchStatus(dir)).done,1);
  await closeBatch(dir,next.batch_id);
  const ledger=path.join(dir,'parallel/batches/state.json'),state=await readJson(ledger);state.needs_refresh=true;await writeJson(ledger,state);
  assert.equal((await batchStatus(dir)).total,2);assert.equal((await readJson(ledger)).needs_refresh,undefined);
});
