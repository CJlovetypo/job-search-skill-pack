import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson,workspacePath,SKILL_ROOT} from '../../shared/job-search-core/scripts/lib/io.mjs';

const cell=value=>String(value??'').replace(/\\/g,'\\\\').replace(/[\[\]`*_]/g,'\\$&').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ').replace(/[<>]/g,'');
function link(url){
  try{const u=new URL(url);return ['https:','http:'].includes(u.protocol)?u.href.replace(/[()]/g,c=>c==='('? '%28':'%29'):null;}catch{return null;}
}
export async function renderDiscovery(directory){
  const dir=workspacePath(directory),run=await readJson(path.join(dir,'run.json'));
  if(run.purpose!=='discover')throw Error('render-discovery 只用于岗位发现运行');
  if(!run.collected_at)throw Error('尚未完成 collect，不能称已取得岗位清单');
  const coverage=[],jobs=[];
  for(const company of run.companies.filter(c=>c.selected)){
    const snapshot=await readJson(path.join(dir,'companies',company.company_id+'.json'),null);
    coverage.push({company_id:company.company_id,company:company.display_name,checked_at:snapshot?.checked_at??null,
      status:snapshot?.coverage?.status||'not_collected',reason:snapshot?.coverage?.reason||null,
      counts:snapshot?.counts||{},coverage:snapshot?.coverage||null});
    for(const job of snapshot?.jobs||[]){
      if(String(job.evaluation_status).startsWith('excluded_'))continue;
      jobs.push({company_id:company.company_id,company:company.display_name,job_id:String(job.job_id),title:job.title,
        cities:job.cities||[],recruitment:job.formal_status,open_status:job.open_status,
        data_status:job.evaluation_status,body_complete:job.body_complete===true,
        url:link(job.official_url),verification_issues:job.verification_issues||[],
        role_relevance:job.role_relevance||null,assessment_status:'not_assessed',raw_file:job.raw_file||null});
    }
  }
  const result={schema_version:1,is_test:run.is_test===true,purpose:'discover',generated_at:new Date().toISOString(),
    notice:'岗位候选，尚未进行个人匹配；没有能力评级或投递建议。',
    task:run.task_snapshot?{task_id:run.task_snapshot.task_id,revision:run.task_snapshot.revision}:null,
    retrieval_mode:run.retrieval_mode||'exhaustive',search_plan:run.search_plan||null,
    role_intent:run.task_snapshot?.conditions?.roles?.value||[],
    selection_summary:run.selection_summary,role_review:run.role_review||null,jobs,coverage};
  const out=path.join(SKILL_ROOT,'outputs',path.basename(dir));await fs.mkdir(out,{recursive:true});
  const json=path.join(out,'岗位候选.json'),markdown=path.join(out,'岗位候选.md');
  await writeJson(json,result);
  const lines=['# 岗位候选','',result.notice,'',
    `岗位 ${jobs.length} 条；采集来源 ${coverage.length} 个。范围仅限已收录来源与本轮条件。`,
    `目标职能：${cell(result.role_intent.join('、'))||'未指定'}。${run.role_review?`全文相关性已审 ${run.role_review.reviewed} 条，待审 ${run.role_review.pending} 条；待确认结论保留在清单。`:'本清单尚未逐条确认职能相关性。'}全量模式没有用标题过滤。`,
    `城市过滤：${cell(run.profile.city_filters?.join('、'))||'本轮未设过滤'}；公司城市标签未命中排除 ${run.selection_summary?.city_excluded||0} 个，并不证明这些公司没有招聘。`,
    ...(run.search_plan?[`定向标题词：${cell(run.search_plan.keywords.join('、'))}。可能遗漏标题未体现的机会。`]:[]),'',
    '| 公司 | 岗位 | 城市 | 资料状态 | 官方入口 |','| --- | --- | --- | --- | --- |',
    ...jobs.map(j=>`| ${cell(j.company)} | ${cell(j.title)} | ${cell(j.cities.join('、'))||'待核实'} | ${j.data_status==='to_assess'?'资料可评估，未做个人匹配':'资料待核实'} | ${j.url?`[查看岗位](${j.url})`:'无有效直达链接'}（ID：${cell(j.job_id)}） |`),'',
    '## 来源覆盖','', '| 公司 | 状态 | 资料时间 | 限制 |','| --- | --- | --- | --- |',
    ...coverage.map(c=>`| ${cell(c.company)} | ${cell(c.status)} | ${cell(c.checked_at)||'未知'} | ${cell(c.reason)||'以本轮来源契约为限'} |`),'',
    '失败、部分覆盖和真实空列表分别记录；列表未命中不代表全市场无岗位。完整结构化记录见同目录岗位候选.json。',''];
  await fs.writeFile(markdown,lines.join('\n'),'utf8');
  return {markdown,json,jobs:jobs.length,coverage:coverage.length,assessment_status:'not_assessed'};
}
