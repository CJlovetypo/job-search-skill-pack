// The agent interprets language. This module validates declared decisions and
// computes stage gates; it deliberately contains no prompt/keyword classifier.
import {retrievalIssues} from './query-selection.mjs';
import {createHash} from 'node:crypto';
import {isV5} from './assessment-v5.mjs';
import {normalizeBusinessFilters,businessMatchMode} from './business-taxonomy.mjs';

export const TASK_VERSION = 1;
export const GOALS = ['clarify','consult','capabilities','discover','match','compare','explore','radar'];
export const MODES = ['campus','internship','social'];
const states = ['explicit','inherited','unspecified','conflict'];
const arrayFields = ['industries','businesses','companies','cities','roles'];
const nonBlockingConditions=new Set(['salary','commute','office_distance']);
const text = x => typeof x === 'string' && x.trim().length > 0;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export const specified = c => ['explicit','inherited'].includes(c?.state);
export function taskFingerprint(task) {
  const stable = value => Array.isArray(value) ? value.map(stable) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k,stable(value[k])])) : value;
  return createHash('sha256').update(JSON.stringify(stable(task))).digest('hex');
}

export function validateTask(task) {
  const errors=[];
  if(!object(task))return ['任务必须为对象'];
  if(task.schema_version!==TASK_VERSION)errors.push('schema_version 必须为 1');
  if(!text(task.task_id)||!/^[a-zA-Z0-9_-]+$/.test(task.task_id))errors.push('task_id 必须为字母数字下划线或连字符');
  if(!Number.isInteger(task.revision)||task.revision<1)errors.push('revision 必须为正整数');
  if(!text(task.user_request))errors.push('缺少用户真实 user_request');
  if(!GOALS.includes(task.goal))errors.push('goal 无效');
  if(typeof task.is_test!=='boolean')errors.push('必须显式记录 is_test');
  if(!object(task.conditions))errors.push('缺少 conditions');
  for(const [key,c] of Object.entries(task.conditions||{})) {
    if(!object(c)||!states.includes(c.state)){errors.push(key+' 缺少有效信息状态');continue;}
    if(c.state==='unspecified'&&c.value!=null)errors.push(key+' 未指定时 value 必须为 null');
    if(c.state!=='unspecified'&&!text(c.basis))errors.push(key+' 缺少来源依据 basis');
    if(specified(c)&&key==='recruitment'&&!MODES.includes(c.value))errors.push('招聘方向必须为单一 campus/internship/social，多方向分开运行');
    if(specified(c)&&arrayFields.includes(key)&&(!Array.isArray(c.value)||c.value.some(x=>!text(x))||new Set(c.value).size!==c.value.length))errors.push(key+' 必须为不重复字符串数组；空数组表示明确不限');
    if(specified(c)&&key==='industries'&&Array.isArray(c.value)&&c.value.includes('all')&&c.value.length>1)errors.push('不限行业不能混入其他行业');
    if(key==='cities'&&c.importance!=null&&!['must','prefer','open'].includes(c.importance))errors.push('城市importance须为must/prefer/open');
    if(key==='businesses'&&specified(c))try {normalizeBusinessFilters(c.value);businessMatchMode(c.match);}catch(e){errors.push(e.message);}
  }
  const r=task.retrieval;
  if(!object(r)||!['exhaustive','targeted'].includes(r.mode)||!['default','explicit','inherited'].includes(r.selection)||!text(r.basis))errors.push('retrieval 需要 mode、selection、basis');
  else if(r.mode==='targeted'&&r.selection==='default')errors.push('普通目标不能默认启用 targeted；需要用户明确选择依据');
  const s=task.evaluation_scope;
  if(s!=null){
    if(!object(s)||!states.includes(s.state))errors.push('evaluation_scope 状态无效');
    else if(s.state==='unspecified'&&s.value!=null)errors.push('未指定评估范围时 value 必须为 null');
    else if(specified(s)){
      if(!text(s.basis)||!object(s.value)||!['sample','companies','all'].includes(s.value.mode))errors.push('评估范围需要依据和 sample/companies/all');
      else {
        if(s.value.mode==='sample'&&(!Number.isInteger(s.value.limit)||s.value.limit<1))errors.push('样本范围需要正整数 limit');
        if(s.value.mode==='companies'&&(!Array.isArray(s.value.companies)||!s.value.companies.length||s.value.companies.some(x=>!text(x))))errors.push('指定公司范围需要明确 companies');
        if(s.value.companies!=null&&(!Array.isArray(s.value.companies)||!s.value.companies.length||s.value.companies.some(x=>!text(x))||new Set(s.value.companies).size!==s.value.companies.length))errors.push('范围 companies 必须为非空且不重复的公司ID数组');
        if(s.value.selection!=null&&!['sample','display_order','rank_after_assessment'].includes(s.value.selection))errors.push('样本选取方式无效');
        if(s.value.mode==='sample'&&s.value.selection==='rank_after_assessment')errors.push('最适合前N需要明确比较母集后评估，不能用sample冒充排名');
      }
    }
  }
  if(!object(task.materials))errors.push('缺少 materials 状态');
  for(const [key,value] of Object.entries(task.materials||{}))if(!['available','missing','partial','unreadable','conflict','not_needed'].includes(value))errors.push('材料状态无效：'+key);
  if(task.issues!=null&&!Array.isArray(task.issues))errors.push('issues 必须为数组');
  else for(const issue of task.issues||[])if(!object(issue)||!text(issue.field)||!text(issue.reason)||!text(issue.question)||!Array.isArray(issue.blocks)||issue.blocks.some(s=>!['collect','assess','schedule'].includes(s)))errors.push('issue 需要 field、reason、question 和合法 blocks');
  if(task.changes!=null&&(!Array.isArray(task.changes)||task.changes.some(x=>!['cities','industries','businesses','companies','recruitment','evidence','preference','availability','refresh','presentation','scope'].includes(x))))errors.push('changes 存在未知变化类型');
  return errors;
}

export function decideTask(task) {
  const errors=validateTask(task);
  if(errors.length)return {valid:false,errors};
  const c=task.conditions, mode=specified(c.recruitment)?c.recruitment.value:null;
  const gates={collect:[],assess:[],schedule:[]}, questions=[];
  const need=(field,question,stages)=>{
    if(!questions.some(q=>q.field===field))questions.push({field,question});
    for(const stage of stages)if(!gates[stage].includes(field))gates[stage].push(field);
  };
  const searching=['discover','match','explore'].includes(task.goal);
  if(task.goal==='clarify')need('goal','请明确本轮要继续哪项任务。',['collect','assess','schedule']);
  const radarSearch=task.goal==='radar'&&['create','update'].includes(task.radar_action);
  if(searching||task.goal==='compare'||radarSearch){
    if(!mode)need('recruitment','这次找校招、实习还是社招？',['collect','assess',...(task.goal==='radar'?['schedule']:[])]);
  }
  if(searching||radarSearch)for(const issue of retrievalIssues({roles:specified(c.roles)?c.roles.value:[],retrieval:task.retrieval,scopeKnown:!!(specified(c.industries)||specified(c.companies)&&c.companies.value.length||specified(c.businesses)&&c.businesses.value.length)}))need(issue.field,issue.question,['collect',...(radarSearch?['schedule']:['assess'])]);
  if(radarSearch&&!['industries','businesses','companies','roles'].some(k=>specified(c[k])&&c[k].value.length&&!(k==='industries'&&c[k].value.includes('all'))))need('radar_target','想持续关注哪些岗位、行业、业务或公司？',['collect','schedule']);
  for(const [key,value] of Object.entries(c))if(value.state==='conflict'&&!nonBlockingConditions.has(key))need(key,'请明确 '+key+' 中冲突的条件。',['collect','assess']);
  if(['match','compare','explore'].includes(task.goal)&&task.materials.profile!=='available')need('profile','请提供可核对的实际职责、个人行动与产出；已有文字或脱敏材料即可。',['assess']);
  if(task.goal==='compare'&&task.materials.jd!=='available')need('jd','请提供或定位要比较的完整岗位资料。',['assess']);
  if(['match','explore'].includes(task.goal)&&task.materials.jd!=='available')gates.assess.push('jd_collection');
  if(['match','compare','explore'].includes(task.goal)&&!specified(task.evaluation_scope))need('evaluation_scope','候选数量明确后，这次评估一批、指定公司还是全部？',['assess']);
  if(task.goal==='radar'&&task.radar_action!=='history'){
    if(!['create','update','pause','mute','resume','history'].includes(task.radar_action))need('radar_action','要建立、调整、暂停哪项关注，还是只暂停通知？',['schedule']);
    if(['create','update','resume'].includes(task.radar_action)&&(!specified(c.schedule)||!text(c.schedule.value?.time)||!text(c.schedule.value?.timezone)))need('schedule','具体何时执行、使用哪个时区？',['schedule']);
    if(['update','pause','mute','resume'].includes(task.radar_action)&&!task.subscription_id)need('subscription','请先定位要操作的已有订阅。',['schedule']);
  }
  for(const issue of task.issues||[])if(!nonBlockingConditions.has(issue.field))need(issue.field,issue.question,issue.blocks);
  const changes=task.changes||[], actions=[];
  if(changes.includes('refresh'))actions.push('refresh_jobs');
  if(changes.some(x=>['cities','industries','businesses','companies'].includes(x)))actions.push('new_run_extend_scope_reuse_valid_jd');
  if(changes.includes('recruitment'))actions.push('new_direction_runtime_verify_direction_and_cities');
  if(changes.some(x=>['evidence','preference','availability','recruitment'].includes(x)))actions.push('invalidate_assessments_reuse_unchanged_facts');
  if(changes.includes('scope'))actions.push('update_scope_use_remaining_jobs');
  if(changes.length&&changes.every(x=>x==='presentation'))actions.push('render_existing_valid_assessments');
  const independent=['read_available_materials_and_history'];
  if(!specified(c.industries)&&searching)independent.push('show_industries');
  if(specified(c.companies))independent.push('resolve_company_ids');
  if(task.goal==='capabilities')independent.push('show_capabilities_and_coverage');
  if(task.goal==='radar')independent.push('inspect_existing_subscriptions');
  // Scope is deliberately deferred until after collection, not a first-turn form.
  const now=questions.filter(q=>q.field!=='evaluation_scope');
  return {valid:true,task_id:task.task_id,revision:task.revision,goal:task.goal,mode,
    route:task.goal==='radar'?'job-radar':'job-search',
    retrieval:task.retrieval.mode,city_policy:specified(c.cities)?'user_defined':'unrestricted_this_run_not_user_preference',
    gates,questions_now:now.slice(0,3),questions_later:[...now.slice(3),...questions.filter(q=>q.field==='evaluation_scope')],
    independent_actions:independent,change_actions:actions,
    can_collect:(searching||radarSearch)&&gates.collect.length===0,can_assess:['match','compare','explore'].includes(task.goal)&&gates.assess.length===0,
    can_review_partial:['match','compare','explore'].includes(task.goal)&&gates.assess.filter(x=>x!=='profile').length===0,
    assessment_limitations:gates.assess.includes('profile')?['个人事实不足时按v5保留不确定，仅判断有依据的维度；不虚构经历，不把缺证当作不符。']:[],
    required_notices:[...(c.salary&&c.salary.state!=='unspecified'?['招聘信息中的薪资可能不准确，仅供参考，不代表实际录用待遇；不按薪资硬筛岗位。']:[]),...(['commute','office_distance'].some(k=>c[k]&&c[k].state!=='unspecified')?['本包只匹配城市，不支持同城距离或通勤要求；这些要求会被忽略，不作为后续执行目标。']:[])],
    requires_full_jd:true,can_auto_apply:false};
}

export function reviseTask(previous,patch) {
  const problems=validateTask(previous);if(problems.length)throw Error(problems.join('；'));
  if(patch.task_id!==previous.task_id||patch.revision!==previous.revision+1)throw Error('修订必须使用相同 task_id 和连续 revision');
  if(!text(patch.user_request))throw Error('修订需要本轮真实 user_request');
  const inherited=c=>specified(c)?{...structuredClone(c),state:'inherited',basis:`任务 ${previous.task_id} r${previous.revision}：${c.basis}`}:structuredClone(c);
  const conditions=Object.fromEntries(Object.entries(previous.conditions).map(([k,c])=>[k,inherited(c)]));
  const next={...structuredClone(previous),...patch,conditions:{...conditions,...patch.conditions},
    materials:{...previous.materials,...patch.materials},issues:patch.issues??structuredClone(previous.issues||[]),changes:patch.changes||[],
    evaluation_scope:patch.evaluation_scope??(previous.evaluation_scope?inherited(previous.evaluation_scope):undefined),
    supersedes:{task_id:previous.task_id,revision:previous.revision,fingerprint:taskFingerprint(previous)}};
  if(!patch.retrieval)next.retrieval={...next.retrieval,selection:next.retrieval.selection==='default'?'default':'inherited'};
  const errors=validateTask(next);if(errors.length)throw Error(errors.join('；'));return next;
}

const equalSet=(a,b)=>JSON.stringify([...new Set(a)].sort())===JSON.stringify([...new Set(b)].sort());
export function assertTaskExecution(task,profile,mode,{discovery=false,searchPlan=null}={}) {
  const plan=decideTask(task);if(!plan.valid)throw Error(plan.errors.join('；'));
  if(plan.mode!==mode)throw Error('任务招聘方向与执行方向不一致');
  if(discovery?!['discover','match','explore'].includes(task.goal):!['match','compare','explore'].includes(task.goal))throw Error('任务目标与执行分支不一致');
  if(plan.gates.collect.length)throw Error('采集前须解决：'+plan.gates.collect.join('、'));
  const preparationGaps=plan.gates.assess.filter(x=>!['evaluation_scope','jd_collection',...(isV5(profile)?['profile']:[])].includes(x));
  if(!discovery&&preparationGaps.length)throw Error('匹配准备前须解决：'+preparationGaps.join('、'));
  if(!discovery&&!isV5(profile)){
    if(!text(profile.degree))throw Error('正式匹配准备需要真实学历');
    if(mode==='campus'&&!text(profile.graduation))throw Error('校招正式匹配准备需要真实毕业时间');
  }
  const c=task.conditions;
  if(task.goal==='compare'&&!(specified(c.companies)&&c.companies.value.length))throw Error('比较给定岗位须先定位有限公司范围；不能默认全库采集');
  const cityValues=specified(c.cities)?c.cities.value:[];
  const softCity=['prefer','open'].includes(c.cities?.importance);
  if(!equalSet(profile.city_filters||[],softCity?[]:cityValues))throw Error('执行城市与任务条件不一致；软偏好不能转成硬排除');
  if(isV5(profile)&&profile.city_preference){
    const expectedImportance=c.cities?.importance||(cityValues.length?'must':'open');
    if(!equalSet(profile.city_preference.values||[],cityValues)||profile.city_preference.importance!==expectedImportance)throw Error('城市偏好与任务条件不一致');
  }
  if(!equalSet(profile.company_filters||[],specified(c.companies)?c.companies.value:[]))throw Error('执行公司与任务条件不一致；先将公司解析为真实ID');
  const industries=specified(c.industries)?(c.industries.value.length?c.industries.value:['all']):['all'];
  if(!equalSet(profile.industry_filters||[],industries))throw Error('执行行业与任务条件不一致');
  const businesses=normalizeBusinessFilters(specified(c.businesses)?c.businesses.value:[]);
  if(!equalSet(normalizeBusinessFilters(profile.business_filters),businesses)||businessMatchMode(profile.business_filter_match)!==businessMatchMode(specified(c.businesses)?c.businesses.match:undefined))throw Error('执行业务硬筛选与任务条件不一致');
  if((searchPlan?'targeted':'exhaustive')!==task.retrieval.mode)throw Error('执行检索策略与任务选择不一致');
  if(!!profile.is_test!==task.is_test)throw Error('任务与画像 is_test 不一致');
  return plan;
}

export function assertTaskScope(task,{mode,limit,companyIds,jobs,candidateCount}={}) {
  const errors=validateTask(task);if(errors.length)throw Error(errors.join('；'));
  if(!specified(task.evaluation_scope))throw Error('任务尚未明确评估范围；先保存用户选择的任务修订，再通过 --task 绑定');
  const scope=task.evaluation_scope.value;
  if(scope.mode!==mode)throw Error('执行评估范围与任务承诺不一致');
  if(mode==='sample'&&scope.limit!==Number(limit))throw Error('执行样本数量与任务承诺不一致');
  if(['sample','companies'].includes(mode)&&!equalSet(scope.companies||[],companyIds||[]))throw Error('执行评估公司与任务承诺不一致；不能用 --only 暗中缩小范围');
  if(scope.selection==='display_order'&&(!Array.isArray(jobs)||!jobs.length))throw Error('前N个需要按已展示顺序提供固定岗位键，不能替换成抽样');
  if(mode==='sample'&&Array.isArray(jobs)){
    if(!Number.isInteger(candidateCount)||candidateCount<0)throw Error('固定样本清单需要核对当前可评估岗位数量');
    if(jobs.length!==Math.min(scope.limit,candidateCount))throw Error('固定岗位清单数量与任务承诺不一致；只有当前母集不足时才能少于样本数量');
  }
  if(Array.isArray(scope.jobs)&&JSON.stringify(scope.jobs)!==JSON.stringify(jobs))throw Error('固定岗位清单与任务承诺不一致');
}

export function assertScopeRevision(previous,next) {
  if(taskFingerprint(previous)===taskFingerprint(next))return;
  if(next.task_id!==previous.task_id||next.revision!==previous.revision+1||next.supersedes?.fingerprint!==taskFingerprint(previous))throw Error('新评估范围须绑定当前任务的连续修订');
  const conditions=value=>Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,c])=>[key,{state:specified(c)?'known':c.state,value:c.value,...(c.importance?{importance:c.importance}:{}),...(key==='businesses'?{match:c.match||'any'}:{})}]));
  if(next.goal!==previous.goal||(next.changes||[]).some(change=>change!=='scope')||
    taskFingerprint(conditions(next.conditions))!==taskFingerprint(conditions(previous.conditions))||
    taskFingerprint(next.materials)!==taskFingerprint(previous.materials)||next.retrieval.mode!==previous.retrieval.mode)throw Error('变更条件或画像需 prepare 新运行，原运行只允许更新评估范围');
}
