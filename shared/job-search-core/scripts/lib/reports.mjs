import path from 'node:path';
import {SKILL_ROOT, readJson, writeJson, workspacePath} from './io.mjs';
import {jobFingerprintMatches} from './job-version.mjs';
import {writeExcelReport} from './excel-report.mjs';
import {ASSESSMENT_VERSION, ABILITY_LEVELS, INTEREST_LEVELS, MATCH_TIER_NAMES, deriveMatchTier, actionProblem, interestProblem} from './matching.mjs';
import {ownershipDisplayTag} from './ownership.mjs';
import {profileFingerprint, profileEvidenceProblem, abilityEvidenceProblem} from './evidence-model.mjs';
import {readEvaluationScope, inEvaluationScope, SCOPE_MODES} from './evaluation-scope.mjs';
import {writeJdArchive} from './jd-archive.mjs';
import {companyProfileSnapshot, saveCompanyProfileSnapshot, companyProfileSheet, profileGaps} from './company-profiles.mjs';
import {SEARCH_MODE,modeEligibilityProblem,eligibilityPolicy} from './search-mode.mjs';
import {isV5,modelVersion,v5DimensionsProblem,v5HardConflict,v5Unknown,CITY_NAMES,SALARY_NAMES,EVIDENCE_NAMES,SALARY_NOTICE} from './assessment-v5.mjs';

export const REPORT_HEADERS = ['公司', '公司业务标签', '公司性质标签', '岗位', '投递建议', '匹配层级', '岗位城市', '意愿匹配度', '能力匹配度', '硬性条件匹配度', '详细评估理由', 'JD链接'];
export const V5_REPORT_HEADERS = [...REPORT_HEADERS,'城市意愿匹配','薪资参考','证据充分性'];
const tierNames = MATCH_TIER_NAMES;
const eligibilityNames = {eligible: '匹配', ineligible: '不匹配', unknown: '待核实'};
const interestLevels = INTEREST_LEVELS;
const abilityLevels = ABILITY_LEVELS;
const visibleStatuses = new Set(['to_assess', 'needs_verification', 'missing_body']);
// Source bodies have already been normalized. Treat them as literal text here;
// stripping apparent tags again could delete requirements such as List<T>.
const clean = value => String(value ?? '').replace(/\r/g, '').trim();
const hasText = value => typeof value === 'string' && value.trim().length > 0;
const list = value => [...new Set((Array.isArray(value) ? value : value ? [value] : []).map(clean).filter(Boolean))].join('、');
const officialLink = job => {
  try { const url = new URL(job.official_url); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
};
const rank = review => ({high: 0, normal: 1, low: 2}[review.priority] ?? 3);
const jobKey = job => JSON.stringify([job.company_id, String(job.job_id)]);
const ownershipTag = ownershipDisplayTag;
const reportTierName = review => review.eligibility === 'ineligible' ? '硬性条件不符' : isV5(review)&&v5HardConflict(review)?'明确不符':review.eligibility==='unknown'||isV5(review)&&v5Unknown(review)?'信息待确认':tierNames[review.match_tier];
const recommendationName = review => review.eligibility === 'ineligible' || review.next_action === 'hold'
  ? '暂不建议投递'
  : review.next_action === 'apply' ? '可以投递' : review.next_action==='clarify'?'补资料后判断':'投递前准备';

export function verificationReviewSheet(audit) {
  const sheet={name:'资料复核',headers:['公司','岗位','复核结果','招聘性质（前→后）','城市（前→后）','正文（前→后）','仍待核实事项','复核依据','岗位ID','官方入口'],rows:[],links:[]};
  const pending=new Set(['needs_verification','missing_body']);
  const type={formal:'校招正式岗',unknown:'未确认',social:'社招',internship:'实习',activity:'校园活动／博士后',parttime:'兼职'};
  const rank=item=>pending.has(item.after.status)?0:item.after.status.startsWith('excluded')?1:2;
  for(const item of [...audit.items].sort((a,b)=>rank(a)-rank(b)||a.company_name.localeCompare(b.company_name,'zh'))){
    const result=pending.has(item.after.status)?'仍待核实':item.after.status==='to_assess'?'核验通过·待评估':'已确认不纳入';
    const evidence=[item.recruitment_review?.reason,item.body_review?.reason,item.location_review?.reason];
    if(item.title_city_evidence?.length)evidence.push('标题城市证据：'+JSON.stringify(item.title_city_evidence));
    if(item.location_code_evidence?.length)evidence.push('地点字段解析依据：'+JSON.stringify(item.location_code_evidence));
    if(item.location_description_evidence?.length)evidence.push('正文工作地点依据：'+JSON.stringify(item.location_description_evidence));
    const decoded=(item.location_structured_evidence||[]).filter(e=>e.source==='locations_raw_json');
    if(decoded.length)evidence.push('接口地点字段：'+decoded.map(e=>`${e.pointer}=${e.value} → ${list(e.cities)||list(e.special)||'未知'}`).join('；'));
    const url=officialLink(item);
    sheet.rows.push([item.company_name,item.title,result,`${type[item.before.formal_status]||item.before.formal_status} → ${type[item.after.formal_status]||item.after.formal_status}`,`${list(item.before.cities)||'未知'} → ${list(item.after.cities)||'未知'}`,`${item.before.body_complete?'完整':'未完整'} → ${item.after.body_complete?'完整':'未完整'}`,(item.remaining_issues||[]).map(x=>x.reason).join('；')||'无（不等于个人匹配评估已完成）',evidence.filter(Boolean).join('\n'),String(item.job_id),url||'未提供']);
    if(url)sheet.links.push({row:sheet.rows.length+1,column:10,url,label:url});
  }
  return sheet;
}

// A process declaration is not proof of reading: the model must actually read
// the complete JD and produce the evidence comparisons before setting it.
export function reviewNeedsUpdate(review, job, profile) {
  if (job.body_complete !== true) return (job.body_review?.reason||'正文获取或内容识别待核')+'；不能形成全文评估';
  if (!review) return '尚未评估';
  if (review.review_method !== 'full_jd') return '缺少全文阅读评估记录，需完整阅读 JD 后重新评估';
  if (!jobFingerprintMatches(review.jd_fingerprint,job)) return 'JD更新，旧评估已失效';
  if (review.assessment_version !== modelVersion(profile)) return '评估模型版本已变化，需独立重评；不可由旧匹配层级反推能力或仅补版本字段';
  const profileProblem = profileEvidenceProblem(profile);
  if (profileProblem) return '个人画像需补齐证据分类：' + profileProblem;
  if (review.profile_fingerprint !== profileFingerprint(profile)) return '个人画像缺少匹配指纹或已更新，需对当前画像重新评估，不能复用其他画像的证据 ID';
  if (!Object.hasOwn(abilityLevels, review.ability)) return '缺少有效的独立能力评估';
  if (!Object.hasOwn(interestLevels, review.interest)) return '缺少有效的独立意愿评估';
  if (review.ability === 'unknown'&&!isV5(profile)) return '资料不足，尚未形成完整能力评估';
  const derived = deriveMatchTier(review.ability, review.interest);
  if (review.match_tier != null && review.match_tier !== derived) return '匹配层级与独立能力、意愿判断不一致，需复核评估';
  if (!Object.hasOwn(eligibilityNames, review.eligibility) || !['high', 'normal', 'low'].includes(review.priority)) return '硬性条件或内部排序字段无效';
  if (review.interest !== 'unknown' && !hasText(review.interest_reason)) return '缺少独立意愿依据 interest_reason；需说明用户明确倾向，不能用能力证据代替';
  if (!hasText(review.conclusion) || !hasText(review.next_step)) return '缺少具体结论或行动建议';
  if (!hasText(review.eligibility_reason)) return '硬性条件结论缺少当前招聘方向的具体依据';
  if (SEARCH_MODE.id==='campus'&&!isV5(profile)) {
    if (!hasText(profile?.graduation) || !hasText(profile?.degree)) return '个人画像缺少毕业时间或学历，不能形成正式岗位评估';
    if (review.eligibility === 'unknown') return '完整JD未写届别或学历限制时按未发现硬性冲突处理；不得在正式评估中标为待核实';
  }else {const issue=modeEligibilityProblem(review,profile);if(issue)return issue;}
  const comparisons = review.comparisons;
  if (!Array.isArray(comparisons) || !comparisons.length) return '缺少 JD 与个人证据对照';
  const ids = profile ? new Set((profile.evidence || []).map(item => item.id)) : null;
  for (const comparison of comparisons) {
    if (!comparison || !hasText(comparison.jd_requirement) || !hasText(comparison.explanation)) return '对照缺少要求或解释';
    if (!Array.isArray(comparison.profile_evidence_ids)) return '个人证据 ID 必须为数组；没有证据时使用空数组';
    for (const id of comparison.profile_evidence_ids) if (!hasText(id) || (ids && !ids.has(id))) return '引用了不存在的个人证据 ' + String(id);
  }
  if (['high', 'medium'].includes(review.ability) && !comparisons.some(item => item.profile_evidence_ids.length)) return '高或中能力判断必须有个人经历证据';
  if (review.ability === 'medium' && !hasText(review.transferable_evidence)) return '中能力判断缺少可迁移经历说明';
  const abilityProblem = abilityEvidenceProblem(review, profile);
  if (abilityProblem) return abilityProblem;
  const dimensionProblem=v5DimensionsProblem(review,profile,job);if(dimensionProblem)return dimensionProblem;
  for (const field of ['conclusion', 'ability', 'interest', 'gaps']) {
    if (!hasText(review.report_summary?.[field])) return '缺少易读报告摘要 report_summary.' + field + '；须由模型概括结论，不用逐项证据列表代替';
  }
  const actionIssue = actionProblem(review);
  if (actionIssue) return actionIssue;
  const interestIssue = interestProblem(review);
  if (interestIssue) return interestIssue;
  return null;
}

function validateReview(review) {
  return {...review, match_tier: deriveMatchTier(review.ability, review.interest)};
}

function withoutLeadingRating(value, rating) {
  const text = clean(value);
  for (const separator of ['。', '，', '：', ':', ';', '；']) {
    const prefix = rating + separator;
    if (text.startsWith(prefix)) return text.slice(prefix.length).trimStart();
  }
  return text;
}

function detailedReason(review) {
  // Reader-facing synthesis is written by the model after the full comparison.
  // Evidence IDs and raw comparisons remain in assessment JSON, not this cell.
  const summary = review.report_summary;
  const hardReason = clean(review.eligibility_reason).replace(/[。；;]+$/, '');
  const conclusion = [clean(summary.conclusion), '硬性条件' + eligibilityNames[review.eligibility] + '：' + hardReason + '。', '综合为' + reportTierName(review) + '。'];
  conclusion.push('投递建议：' + recommendationName(review) + '。');
  return [
    '评估结论：' + conclusion.join(' '),
    '能力匹配度结论：' + abilityLevels[review.ability] + '。' + withoutLeadingRating(summary.ability, abilityLevels[review.ability]),
    '个人意愿匹配度结论：' + interestLevels[review.interest] + '。' + withoutLeadingRating(summary.interest, interestLevels[review.interest]),
    '主要缺口：' + clean(summary.gaps),
  ].join('\n\n');
}

export async function buildReportData(dir, {allowPartial = false} = {}) {
  dir = workspacePath(dir);
  const run = await readJson(path.join(dir, 'run.json'));
  const v5=isV5(run.profile);
  if((run.search_mode||'campus')!==SEARCH_MODE.id)throw Error('报告运行的招聘方向与本 Skill 不一致');
  const scope = await readEvaluationScope(dir, {required: false});
  const bundles = [], assessed = [], missing = [], unattempted = [];
  for (const company of run.companies) {
    if (!company.selected) { bundles.push({company, status: '城市标签排除', jobs: [], reviews: []}); continue; }
    const data = await readJson(path.join(dir, 'companies', company.company_id + '.json'), null);
    if (!data) { unattempted.push(company.display_name); bundles.push({company, status: '尚未获取', jobs: [], reviews: []}); continue; }
    const submitted = (await readJson(path.join(dir, 'assessments', company.company_id + '.json'), {assessments: []})).assessments;
    const jobIds = new Set(data.jobs.map(job => String(job.job_id)));
    const seen = new Set();
    for (const review of submitted) {
      if (seen.has(String(review.job_id)) || !jobIds.has(String(review.job_id))) throw new Error(company.display_name + ' 重复或未知评估岗位 ' + review.job_id);
      seen.add(String(review.job_id));
    }
    const byId = new Map(submitted.map(review => [String(review.job_id), review]));
    const bundle = {company, data, jobs: data.jobs, reviews: [], status: data.coverage.status === 'failed' ? '获取失败' : data.coverage.status === 'partial' ? '部分获取' : '已获取'};
    for (const job of data.jobs.filter(value => value.evaluation_status === 'to_assess')) {
      const review = byId.get(String(job.job_id));
      const reason = reviewNeedsUpdate(review, job, run.profile);
      if (reason) { missing.push({company: company.display_name, company_id: company.company_id, job_id: job.job_id, reason, in_scope: inEvaluationScope(scope, company.company_id, job.job_id)}); continue; }
      const item = {...validateReview(review), job, company, bundle};
      bundle.reviews.push(item); assessed.push(item);
    }
    bundles.push(bundle);
  }
  const scopeMissing = missing.filter(item => item.in_scope);
  const scopeUnattempted = bundles.filter(bundle => bundle.status === '尚未获取' && (!scope || scope.mode === 'all' || scope.company_ids.includes(bundle.company.company_id)));
  if (scopeMissing.length && !allowPartial) throw new Error('本次评估范围还有 ' + scopeMissing.length + ' 个岗位尚未评估（含需全文重评），不能输出范围完整的报告；用 next-batch 继续。首项：' + scopeMissing[0].company + '／' + scopeMissing[0].job_id + '：' + scopeMissing[0].reason);
  if (scopeUnattempted.length && !allowPartial) throw new Error('本次评估范围还有 ' + scopeUnattempted.length + ' 家入选公司尚未获取，不能输出完整报告；请先 collect。');
  const comparableSalary=(a,b)=>v5&&['ability','interest','eligibility'].every(k=>a[k]===b[k])&&a.city_check?.status===b.city_check?.status?Number(a.salary_check?.status==='gap')-Number(b.salary_check?.status==='gap'):0;
  assessed.sort((a, b) => rank(a) - rank(b) || (v5?reportTierName(a).localeCompare(reportTierName(b),'zh')||JSON.stringify([a.ability,a.interest,a.eligibility,a.city_check?.status]).localeCompare(JSON.stringify([b.ability,b.interest,b.eligibility,b.city_check?.status]))||comparableSalary(a,b):0) || a.company.display_name.localeCompare(b.company.display_name, 'zh') || a.job.title.localeCompare(b.job.title, 'zh'));
  const pending = bundles.flatMap(bundle => bundle.jobs.filter(job => ['needs_verification', 'missing_body'].includes(job.evaluation_status)).map(job => ({bundle, job})));
  const audit = {
    generated_at: new Date().toISOString(), assessment_version: modelVersion(run.profile), profile_fingerprint: profileFingerprint(run.profile), companies_total: bundles.length,
    companies_selected: bundles.filter(bundle => bundle.company.selected).length,
    assessed_jobs: assessed.length, missing_assessments: missing, unattempted_companies: unattempted,
    source_failures: bundles.filter(bundle => ['获取失败', '尚未获取'].includes(bundle.status)).map(bundle => bundle.company.display_name),
    partial_sources: bundles.filter(bundle => bundle.status === '部分获取').map(bundle => bundle.company.display_name),
    needs_verification: pending.length,
    pending_job_issues: pending.map(({bundle, job}) => ({company_id: bundle.company.company_id, job_id: String(job.job_id), status: job.evaluation_status, issues: job.verification_issues || [], body_review: job.body_review, recruitment_review: job.recruitment_evidence?.admission_review})),
    complete_assessment: missing.length === 0 && unattempted.length === 0,
    complete_collection: bundles.every(bundle => !bundle.company.selected || bundle.data?.coverage.status === 'complete'),
    evaluation_scope: scope,
    scope_assessed_jobs: assessed.filter(item => inEvaluationScope(scope, item.company.company_id, item.job.job_id)).length,
    scope_missing_assessments: scopeMissing.length,
    outside_scope_remaining: missing.length - scopeMissing.length,
    complete_evaluation_scope: scopeMissing.length === 0 && scopeUnattempted.length === 0,
  };
  audit.reviewed_with_uncertainty=assessed.filter(r=>v5Unknown(r)).length;
  const main = {name: '岗位匹配', headers: [...(v5?V5_REPORT_HEADERS:REPORT_HEADERS)], rows: [], links: [],modelVersion:modelVersion(run.profile)};
  const unchecked = {name: '待核实与未评估', headers: [...main.headers], rows: [], links: [],modelVersion:modelVersion(run.profile)};
  const coverage = {name: '来源覆盖', headers: ['公司', '公司业务标签', '本轮状态', '列表岗位数', '可评估数', '已评估数', '待评估数', '待核实数', '正文缺失数', '其他城市数', '实际页数', '覆盖说明', '采集时间', '城市标签时间', '公司性质标签', '性质判断说明', '性质来源证据', '性质资料时间', '性质结论状态'], rows: [], links: []};
  const notes = {name: '说明', headers: ['项目', '内容'], rows: [], links: []};
  for (const bundle of bundles) {
    const count = state => bundle.jobs.filter(job => job.evaluation_status === state).length;
    const total = bundle.jobs.length;
    coverage.rows.push([bundle.company.display_name, list(bundle.company.business_tags) || '待确认', bundle.status, total,
      count('to_assess'), bundle.reviews.length, count('to_assess') - bundle.reviews.length,
      count('needs_verification'), count('missing_body'), count('excluded_city'), Array.isArray(bundle.data?.coverage?.pages) ? bundle.data.coverage.pages.length : bundle.data?.coverage?.pages ?? '未记录',
      clean(bundle.company.selected ? bundle.data?.coverage?.reason || (total ? '' : '本轮未取得范围内岗位，参见本轮状态') : bundle.company.selection_reason),
      clean(bundle.data?.checked_at) || '未采集', clean(bundle.company.city_index_updated_at) || '未知', ownershipTag(bundle.company),
      clean(bundle.company.ownership_reason) || '未提供核实说明',
      (bundle.company.ownership_evidence || []).map(item => [clean(item.title), clean(item.url), clean(item.note), clean(item.checked_at)].filter(Boolean).join('｜')).join('\n') || '尚无可核对来源',
      clean(bundle.company.ownership_checked_at) || '未核实',bundle.company.ownership_status==='api_supported'?'API支持，待独立核实':bundle.company.ownership_status==='verified'&&bundle.company.ownership_origin==='fresh_web_review'?'已独立核实':bundle.company.ownership_origin==='legacy_import'?'旧标签，待本轮复核':'待核实']);
  }
  function appendRow(sheet, bundle, job, review, reason) {
    const official = officialLink(job);
    const direct = official && job.job_url_kind === 'official_detail';
    const url = official;
    const label = direct ? official : (official ? '官方入口' : '暂无官方链接') + ' · 岗位ID：' + job.job_id;
    const detail = review ? detailedReason(review) : [
      '评估结论：当前尚未形成可用的岗位匹配结论。',
      '能力匹配度结论：待评估，暂不评级。',
      '个人意愿匹配度结论：待确认，尚未形成有效结论。',
      '主要缺口：' + clean(reason),
    ].join('\n\n');
    sheet.rows.push([bundle.company.display_name, list(bundle.company.business_tags) || '待确认', ownershipTag(bundle.company), clean(job.title),
      review ? recommendationName(review) : '待评估', review ? reportTierName(review) : '待评估',
      list(job.cities) || list(job.locations_raw) || '待核实', review ? interestLevels[review.interest] : '待确认',
      review ? abilityLevels[review.ability] : '待评估', review ? eligibilityNames[review.eligibility] : '待评估', detail, label]);
    if(v5)sheet.rows.at(-1).push(review?CITY_NAMES[review.city_check.status]+'：'+review.city_check.job_basis:'尚未判断',review?['仅供参考：JD薪资可能不准。',SALARY_NAMES[review.salary_check.status]+'｜'+(review.salary_check.raw||'JD未披露可用薪资'),review.salary_check.reason,SALARY_NOTICE].join('\n'):'未评估；'+SALARY_NOTICE,review?[EVIDENCE_NAMES[review.evidence_sufficiency.status],review.evidence_sufficiency.reason,...review.evidence_sufficiency.missing].join('\n'):'尚未审阅');
    if (url) sheet.links.push({row: sheet.rows.length + 1, column: 12, url, label});
  }
  for (const review of assessed) appendRow(main, review.bundle, review.job, review);
  // Internal validation diagnostics stay in the log, not the recipient's workbook.
  const missingMap = new Map(missing.map(item => [JSON.stringify([item.company_id, String(item.job_id)]), item.in_scope ? '该岗位在当前求职条件下尚未评估。' : '该岗位未纳入本次评估范围。']));
  for (const bundle of bundles) {
    const completeIds = new Set(bundle.reviews.map(review => String(review.job_id)));
    for (const job of bundle.jobs.filter(value => visibleStatuses.has(value.evaluation_status) && !completeIds.has(String(value.job_id)))) {
      const reason = ['missing_body','needs_verification'].includes(job.evaluation_status) && job.verification_issues?.length
        ? [...new Set(job.verification_issues.map(item=>({recruitment:'该岗位的'+SEARCH_MODE.label+'性质尚未确认',open_status:'当前开放投递状态尚未确认',location:'具体工作城市或全国／远程安排尚未确认',body:'岗位职责或任职要求资料不完整'}[item.code] || '岗位资料仍有待确认事项')))].join('；')
        : job.evaluation_status === 'missing_body' ? '完整正文未取得' : job.evaluation_status === 'needs_verification' ? '招聘性质、状态或地点待核实' : missingMap.get(jobKey(job)) || '尚未评估';
      appendRow(unchecked, bundle, job, null, reason);
    }
  }
  notes.rows = [
    ['报告范围', audit.complete_assessment && audit.complete_collection ? '本轮范围内评估与采集均完整' : '部分报告：未评估及资料待核实岗位单独保留，来源覆盖限制见对应工作表。'],
    ['评估方式', scope ? SCOPE_MODES[scope.mode] : '历史运行，未记录评估范围选择'],
    ['本次选择范围', scope ? (scope.mode === 'sample' ? `实验批次 ${scope.jobs.length} 个岗位（上限 ${scope.sample_limit} 个）` : scope.mode === 'companies' ? scope.companies.join('、') : '城市筛选后全部入选公司的可评估岗位') : '按已有评估记录展示'],
    ['所选范围完成情况', audit.complete_evaluation_scope ? '已完成所选范围内可评估岗位；采集失败、部分覆盖与资料待核实仍以来源覆盖为准。' : '所选范围仍有未评估岗位或未采集公司。'],
    ['所选范围未评估数', audit.scope_missing_assessments], ['范围外未评估数', audit.outside_scope_remaining],
    ['生成时间（UTC）', audit.generated_at], ['城市筛选', list(run.profile.city_filters) || '不限'],
    ['公司业务偏好', list(run.profile.business_preferences) || '未设置'], ['岗位职能偏好', list(run.profile.role_preferences) || '未设置'],
    ['入选公司数', audit.companies_selected], ['全文评估岗位数', audit.assessed_jobs],
    ['未评估岗位数', missing.length], ['资料待核实岗位数', pending.length], ['来源部分覆盖数', audit.partial_sources.length],
    ['来源失败或未采集数', audit.source_failures.length],
    ['匹配层级', '先执行本方向硬性条件闸门：明确不符＝硬性条件不符，不进入投递；硬性条件匹配后，再按能力与意愿双向汇总：已有能力低或意愿低＝当前匹配不足；无低但有未知＝信息待确认；双高＝双向高匹配；其余已知非低＝双向有条件匹配。'],
    ['硬性条件匹配度', SEARCH_MODE.id!=='campus'?eligibilityPolicy():'只核对JD与用户实际届别、学历：不匹配＝任一项存在明确冲突；匹配＝用户毕业时间和学历已知，且JD对应条件符合或未写相关限制。用户画像缺少毕业时间或学历时停止正式评估。提前实习、到岗时间、专业要求及轮岗信息另行记录，不混入本列。'],
    ['意愿匹配度', '用户明确需求与岗位供给的关系：高＝已知重要需求整体满足；中＝明确可接受的探索或取舍；低＝明确冲突；待确认＝重要意愿或供给未明。业务/性质仅在用户明确在意时计入一次；经历和地点入选不等于喜欢岗位。'],
    ['能力匹配度', 'v4：完整阅读JD后，以对口程度、经历层级、个人贡献和成果质量判断。相近条件下实习优先于学校／个人项目，再看其他相关经历；正式工作按真实工作责任判断，优质对口项目也可支撑高能力。客观经历和成就高于主观自评。高＝决定性核心要求均有中／强直接证据且至少一项强证据；中＝存在客观实践基础但核心覆盖或证据强度尚有缺口；低＝主要要求证据缺口较大；未知＝资料不足。多段独立对口实习增强判断，同一经历拆条不重复增益，不生成分数或录取概率。'],
    ['证据与经历', '客观经历／成就是材料中的具体事实陈述，不代表已完成外部核验；自称熟练、擅长等单独标为主观自评。核对个人行动、责任深度、成果和归属，不凭实习数量、公司名气、学校名气或数字大小直接评级。'],
    ['实习对口分层', '分别判断行业、部门业务和实际岗位职能。同业务跨岗位、同岗位跨业务均有部分对口价值，按JD具体任务判断迁移与缺口；单一维度不同不自动判低。信息不足标待核实。'],
    ['详细评估理由', '每岗只展示四段总结：评估结论、能力匹配度结论、个人意愿匹配度结论、主要缺口。评估结论同时列出当前招聘方向的硬性条件依据；逐项能力证据对照保留在评估记录中，不堆叠到单元格。'],
    ['投递建议', '可以投递＝硬性条件符合、意愿明确且已有可用匹配点；投递前准备＝不存在硬性冲突，但投递前应优化材料、整理案例或针对性准备；暂不建议投递＝硬性条件不符、意愿明确冲突、核心能力差距过大或方向明显偏离。主表不再使用“核实”动作；轮岗范围、业务占比、提前实习等信息写入详细理由，不阻止形成投递建议。'],
    ['公司性质标签', '国企／私企／外企独立于公司业务标签。API有来源支持的结论可用于倾向检索，但仍待独立核实；旧标签保留时标明待本轮复核，只有本轮正文复核完成才显示已独立核实。状态、判断说明、来源和时间保留在来源覆盖，不能根据名称、上市地或业务猜测。'],
    ['阅读与评估要求', '每项结论须在完整阅读岗位职责、任职要求及招聘证据后产生。v4同时绑定JD与完整个人画像指纹。程序检查证据分类和结构一致性，不能证明真实阅读、事实真实性或语义判断正确；旧模型结论需重评。'],
    ['JD链接', '优先链接官方单岗位页；无独立详情页时链接官方招聘入口并标注岗位ID。全文与招聘证据另存于独立JD归档，需要查看快照时按公司和岗位ID提取。'],
    ['JD原文存储', '完整JD、招聘证据和采集时间保存在独立过程文件 jd-originals.jsonl，未嵌入本工作簿。无官方链接时可通过公司和岗位ID请求查看归档。'],
    ['多城市岗位', '一行一个岗位，岗位城市保留全部选项，不保证最终分配到其中某城。'],
    ['资料核验规则', '接口明确标注校招、岗位关联校招项目或有可核对的单一校招类型请求筛选，即可确认校招，不另要求“正式／全职”字段。标题明确标注的工作城市直接认可；保留地点、项目和请求原始证据。真实用工类型冲突、缺城市及缺正文仍分别记录。'],
    ['城市标签快照', clean(run.city_index_updated_at) || '未记录'],
  ];
  if(v5){
    const replacements={
      '匹配层级':'已证实资格、核心能力、明确不可接受意愿或must城市冲突为明确不符；关键事实未知为信息待确认，缺证不等于能力低。薪资和参考年限不单独否决。',
      '硬性条件匹配度':'学历、专业及本方向资格分开核对；要求未写与本人事实未给分开。总年限与相关经验仅作经验参考，记录差距和基于职责/责任深度/成果的放宽依据；不设统一宽限，不保证雇主接受。',
      '能力匹配度':'v5：高/中须有对应客观实践；低须已证实核心不符，缺少个人事实用不确定。比较项分别记录符合/部分符合/不符/不确定，证据充分性与能力分开。',
      '投递建议':'可以投递/投递前准备用于有依据且无决定性冲突或未知的结果；无明确冲突但关键事实未知用补资料后判断；已证实冲突用暂不建议投递，其他未知仍保留。',
      '阅读与评估要求':'v5绑定完整JD与画像指纹，全文阅读后按事实判断。未知是有效已审阅结果，不重复领取、不伪装成不符。程序结构校验不证明语义判断正确。'
    };
    notes.rows=notes.rows.map(row=>replacements[row[0]]?[row[0],replacements[row[0]]]:row);
    notes.rows.push(['仍有关键事实不确定的已审阅岗位',audit.reviewed_with_uncertainty],['城市意愿','仅匹配城市；未指定、不限及岗位城市未知分开。同城距离/通勤不支持。'],['薪资参考',SALARY_NOTICE],['证据充分性','说明依据及具体缺项；不是能力分。补问按任务聚合，每轮最多3组。']);
  }
  if (run.is_test) notes.rows.unshift(['测试说明', '本工作簿使用测试画像，不代表真实用户或投递建议。']);
  if (run.report_note) notes.rows.unshift(['本轮说明', clean(run.report_note)]);
  const internalSheets=[coverage,notes];
  if(run.verification_review){
    const verification=await readJson(path.join(dir,'verification-review.json'));
    if(verification.items.length!==run.verification_review.reviewed_count)throw new Error('资料复核记录数与运行摘要不一致');
    internalSheets.push(verificationReviewSheet(verification));
    notes.rows.unshift(['资料复核结果',`原待核实 ${verification.reviewed_count} 个；核验通过待评估 ${verification.results.to_assess||0} 个；仍待核实 ${(verification.results.needs_verification||0)+(verification.results.missing_body||0)} 个；确认不纳入 ${Object.entries(verification.results).filter(([key])=>key.startsWith('excluded')).reduce((sum,[,value])=>sum+value,0)} 个。逐项前后对照见“资料复核”。`]);
    notes.rows.unshift(['公司性质仍待核实',`${verification.ownership_unresolved?.length||0} 家；校招与城市规则不用于推定企业控制关系，具体原因和现有依据见“来源覆盖”。`]);
    audit.verification_review=run.verification_review;
  }
  const profiles = await companyProfileSnapshot(dir, run.companies);
  audit.company_profile_gaps = profileGaps(profiles);
  const publicCoverage = {name: '来源覆盖', headers: ['公司', '岗位范围', '已评估岗位', '未评估岗位', '资料待确认岗位', '范围限制', '岗位资料日期'], rows: [], links: []};
  for (const bundle of bundles) {
    const count = state => bundle.jobs.filter(j => j.evaluation_status === state).length;
    const limitations = [];
    if (!bundle.company.selected) limitations.push('当前城市标签未命中求职城市，未纳入岗位范围。');
    else if (['获取失败', '尚未获取'].includes(bundle.status)) limitations.push('暂无可用岗位资料，不能据此判断该公司没有招聘。');
    else if (bundle.status === '部分获取') limitations.push('仅覆盖部分岗位，不代表该公司全部在招岗位。');
    else if (!bundle.jobs.length) limitations.push('本次未取得岗位，不代表该公司没有其他招聘。');
    if (count('excluded_city')) limitations.push(`另有 ${count('excluded_city')} 个岗位不在求职城市范围。`);
    if (bundle.company.company_id === 'company-5a06b98b2152' && bundle.company.selected) limitations.push('官方 RSS 仅提供最新 10 条岗位。');
    if (run.is_test) limitations.push('测试数据，不用于实际投递。');
    if(run.replay_of)limitations.push('历史快照重新判断，未刷新招聘状态；资料日期见本表。');
    if (run.search_plan) limitations.push('定向检索：'+run.search_plan.target+'；标题词：'+run.search_plan.keywords.join('、')+'。仅覆盖本次候选公司和标题命中岗位，可能遗漏隐含机会。');
    publicCoverage.rows.push([bundle.company.display_name, !bundle.company.selected ? '未纳入' : ['获取失败', '尚未获取'].includes(bundle.status) ? '资料不足' : bundle.status === '部分获取' ? '部分岗位' : '已取得岗位范围', bundle.reviews.length, count('to_assess') - bundle.reviews.length, count('needs_verification') + count('missing_body'), limitations.join('\n') || '以所列岗位及资料日期为准。', bundle.data?.checked_at || '—']);
  }
  const sheets = [main, unchecked, companyProfileSheet(profiles), publicCoverage];
  return {sheets, audit, run, profiles, internalSheets};
}

export async function renderRun(dir, {allowPartial = false, previewDir} = {}) {
  const startedAt=new Date().toISOString(),timer=performance.now();
  dir = workspacePath(dir);
  const report = await buildReportData(dir, {allowPartial});
  await saveCompanyProfileSnapshot(dir, report.profiles);
  const jdArchive = await writeJdArchive(dir);
  const workbookFile = path.join(SKILL_ROOT, 'outputs', path.basename(dir), SEARCH_MODE.report);
  const exportTimer=performance.now();
  await writeExcelReport(workbookFile, report.sheets, {previewDir: previewDir ? workspacePath(previewDir) : undefined, temporaryDir: path.join(dir, 'tmp', 'excel-export')});
  const logFile = path.join(dir, 'logs', 'render-' + report.audit.generated_at.replace(/[:.]/g, '-') + '.json');
  const audit = {...report.audit, workbook_file: workbookFile, output_format: 'xlsx', process_dir: dir, jd_archive: jdArchive, log_file: logFile,
    render_timing:{started_at:startedAt,finished_at:new Date().toISOString(),prepare_ms:Math.round(exportTimer-timer),export_ms:Math.round(performance.now()-exportTimer),total_ms:Math.round(performance.now()-timer)}};
  await writeJson(logFile, {schema_version: 1, ...audit, run_settings: {profile: report.run.profile, report_note: report.run.report_note, city_index_updated_at: report.run.city_index_updated_at, is_test: report.run.is_test}, internal_tables: report.internalSheets, company_profiles: report.profiles});
  await writeJson(path.join(dir, 'report-audit.json'), audit);
  console.log(JSON.stringify({workbook: workbookFile, companies: audit.companies_selected, assessed: audit.assessed_jobs, remaining: audit.missing_assessments.length, needs_verification: audit.needs_verification, partial_sources: audit.partial_sources.length, complete_assessment: audit.complete_assessment, complete_collection: audit.complete_collection, complete_evaluation_scope: audit.complete_evaluation_scope, scope_remaining: audit.scope_missing_assessments, outside_scope_remaining: audit.outside_scope_remaining, jd_archive: jdArchive.file, process_dir: dir}));
  return audit;
}
