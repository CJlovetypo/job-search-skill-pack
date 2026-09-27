const DECIDED_TAGS = new Set(['国企', '私企', '外企']);

// Product use consumes saved decisions; evidence validation belongs to maintenance.
export function ownershipDisplayTag(entry) {
  const status = entry?.ownership_status ?? entry?.status;
  return ['verified','api_supported','demo_unreviewed'].includes(status) && DECIDED_TAGS.has(entry?.ownership_tag) ? entry.ownership_tag : '待核实';
}

const hasText = value => typeof value === 'string' && value.trim().length > 0;
const hasPublicEvidence = entry => Array.isArray(entry?.evidence) && entry.evidence.some(item => {
  try {
    const url = new URL(item?.url);
    return ['http:', 'https:'].includes(url.protocol) && hasText(item?.title) && hasText(item?.note);
  } catch {
    return false;
  }
});

export function ownershipEntryProblem(entry, expectedCompanyId) {
  if (!entry) return '缺少公司性质记录';
  if (expectedCompanyId && entry.company_id !== expectedCompanyId) return '公司 ID 不一致';
  if (!hasText(entry.reason)) return '缺少性质判断或无法判断的具体说明';
  if (!hasText(entry.checked_at)) return '缺少性质资料日期';
  if (entry.status !== 'demo_unreviewed' && !hasPublicEvidence(entry)) return '缺少可核对的公开来源、标题或依据';
  if (DECIDED_TAGS.has(entry.ownership_tag)) return ['verified','api_supported','demo_unreviewed'].includes(entry.status) ? null : '已定性标签的状态必须为 verified、api_supported 或 demo_unreviewed';
  if (entry.ownership_tag === '待核实' && entry.status === 'demo_unreviewed') return null;
  if (entry.ownership_tag === '待核实') return entry.status === 'verified_unresolved' ? null : '待核实仅用于已核查仍无法定性的公司，状态必须为 verified_unresolved';
  return '性质必须为国企、私企、外企或经核查仍无法定性的待核实';
}

export function ownershipDatasetProblems(sources, index) {
  const entries = Array.isArray(index?.companies) ? index.companies : [];
  const byId = new Map();
  const duplicates = new Set();
  for (const entry of entries) {
    if (byId.has(entry?.company_id)) duplicates.add(entry.company_id);
    else byId.set(entry?.company_id, entry);
  }
  const problems = sources.flatMap(source => {
    const problem = ownershipEntryProblem(byId.get(source.company_id), source.company_id);
    return problem ? [{company_id: source.company_id, display_name: source.display_name, problem}] : [];
  });
  for (const companyId of duplicates) problems.push({company_id: companyId, display_name: byId.get(companyId)?.display_name || companyId, problem: '公司性质记录重复'});
  return problems;
}

export function assertOwnershipDatasetComplete(sources, index) {
  const problems = ownershipDatasetProblems(sources, index);
  if (!problems.length) return;
  const preview = problems.slice(0, 8).map(item => `${item.display_name}：${item.problem}`).join('；');
  throw new Error(`公司性质标签数据源未完成：${problems.length} 家不合规。请先维护 data/company-ownership-tags.json；${preview}${problems.length > 8 ? '；……' : ''}`);
}

export function assertRunOwnershipComplete(companies) {
  const problems = (companies || []).flatMap(company => {
    const problem = ownershipEntryProblem({
      company_id: company.company_id,
      ownership_tag: company.ownership_tag,
      status: company.ownership_status,
      reason: company.ownership_reason,
      checked_at: company.ownership_checked_at,
      evidence: company.ownership_evidence,
    }, company.company_id);
    return problem ? [{display_name: company.display_name, problem}] : [];
  });
  if (!problems.length) return;
  const preview = problems.slice(0, 8).map(item => `${item.display_name}：${item.problem}`).join('；');
  throw new Error(`运行快照包含未经确认的公司性质标签：${problems.length} 家。请先补齐数据源并重新 prepare；${preview}${problems.length > 8 ? '；……' : ''}`);
}

export const VALID_OWNERSHIP_TAGS = Object.freeze(['国企', '私企', '外企', '待核实']);
