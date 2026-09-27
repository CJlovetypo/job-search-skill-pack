import {COMPANY_PROFILES_FILE,COMPANY_SIZE_FILE} from '../../registry.mjs';
import path from 'node:path';
import {SKILL_ROOT, readJson, writeJson} from './io.mjs';
import {loadCompanyContext} from './company-records.mjs';

export const PROFILE_FILE = COMPANY_PROFILES_FILE;
export const PROFILE_FIELDS = {business: '业务信息简介', workforce: '公司体量（人数）', capital: '融资／上市／注册资本'};
const text = value => typeof value === 'string' && value.trim().length > 0;
const date = value => text(value) && !Number.isNaN(Date.parse(value));
const webUrl = value => {try {return ['http:', 'https:'].includes(new URL(value).protocol);} catch {return false;}};
export const emptyFact = () => ({value: '', status: 'missing', entity: '', as_of: '', checked_at: '', evidence: []});

export function factProblem(fact) {
  if (!fact || !['verified', 'api_supported', 'demo_unreviewed', 'missing', 'not_disclosed'].includes(fact.status)) return '资料状态无效';
  if (fact.status === 'missing') return fact.value || fact.evidence?.length ? '缺失资料不能含未经核实的数值、简介或来源' : null;
  if (!text(fact.value) || !text(fact.entity) || !date(fact.checked_at)) return '有值资料需要内容、主体口径和资料日期';
  if (!Array.isArray(fact.evidence) || !fact.evidence.length || fact.evidence.some(e => !webUrl(e.url) || !text(e.title) || !text(e.note))) return '有值资料需要可访问的来源 URL、标题和具体依据';
  return null;
}

// Offline maintenance only. Network research supplies reviewed patches separately.
export function mergeProfiles(sources, business, previous, patches = []) {
  const ids = new Set(sources.map(c => c.company_id));
  const old = new Map((previous.companies || []).map(c => [c.company_id, c]));
  const businesses = new Map(business.companies.map(c => [c.company_id, c]));
  const seen = new Set();
  for (const patch of patches) {
    if (!ids.has(patch.company_id) || seen.has(patch.company_id)) throw new Error('未知或重复公司 ID：' + patch.company_id);
    seen.add(patch.company_id);
    for (const field of Object.keys(PROFILE_FIELDS)) if (patch[field]) {
      const issue = factProblem(patch[field]);
      if (issue) throw new Error(patch.company_id + '/' + field + '：' + issue);
    }
  }
  const updates = new Map(patches.map(c => [c.company_id, c]));
  return {schema_version: 1, updated_at: new Date().toISOString(), companies: sources.map(company => {
    const entry = {company_id: company.company_id, display_name: company.display_name};
    for (const field of Object.keys(PROFILE_FIELDS)) entry[field] = updates.get(company.company_id)?.[field] || old.get(company.company_id)?.[field] || emptyFact();
    const b = businesses.get(company.company_id);
    if (entry.business.status === 'missing' && b?.status === 'verified' && text(b.business_summary)) {
      const fact = {value: b.business_summary, status: 'verified', entity: company.display_name + '（品牌／集团业务口径）', as_of: '', checked_at: b.evidence?.[0]?.checked_at || business.updated_at, evidence: b.evidence || []};
      if (!factProblem(fact)) entry.business = fact;
    }
    for (const field of Object.keys(PROFILE_FIELDS)) {
      const issue = factProblem(entry[field]);
      if (issue) throw new Error(company.display_name + '/' + field + '：' + issue);
    }
    return entry;
  })};
}

export async function companyProfileSnapshot(dir, companies, context) {
  const saved = await readJson(path.join(dir, 'company-profiles.snapshot.json'), null);
  if(!saved)context??=await loadCompanyContext();
  const dataset = saved || context.profiles;
  const sizeTags=saved?null:new Map(context.size.companies.map(c=>[c.company_id,c]));
  const byId = new Map();
  for (const entry of dataset.companies) {
    if (byId.has(entry.company_id)) throw new Error('公司简介存在重复 ID：' + entry.company_id);
    byId.set(entry.company_id, entry);
  }
  return {schema_version: 1, source_updated_at: dataset.source_updated_at || dataset.updated_at || null, captured_at: saved?.captured_at || new Date().toISOString(), companies: [...new Map(companies.map(c => [c.company_id, c])).values()].map(c => {
    const entry = {company_id: c.company_id, display_name: c.display_name, size_tag:saved?byId.get(c.company_id)?.size_tag:sizeTags.get(c.company_id)};
    for (const field of Object.keys(PROFILE_FIELDS)) {
      entry[field] = byId.get(c.company_id)?.[field] || emptyFact();
      // Source expansion may retain researched clues before a fact is verified.
      // Keep the clue in the audit snapshot, never promote it into reader-facing facts.
      if(entry[field].status==='partial')entry[field]={...emptyFact(),data_issue:'原资料为待复核线索，未作为已核实公司简介展示',unverified_source_fact:entry[field]};
      const issue = factProblem(entry[field]);
      if (issue) entry[field] = {...emptyFact(), data_issue: issue, unverified_source_fact: entry[field]};
    }
    return entry;
  })};
}

export async function saveCompanyProfileSnapshot(dir, snapshot) {
  await writeJson(path.join(dir, 'company-profiles.snapshot.json'), snapshot);
}

export function companyProfileSheet(snapshot) {
  const sheet = {name: '公司简介', headers: ['公司', '信息类别', '简介', '统计主体／口径', '资料时点', '资料来源'], rows: [], links: []};
  for (const c of snapshot.companies) for (const [field, label] of Object.entries(PROFILE_FIELDS)) {
    const fact = c[field];
    const urls = [...new Set((fact.evidence || []).map(e => e.url))];
    const sizeNote=field==='workforce'&&c.size_tag?`\n求职组织规模：${c.size_tag.label}；${c.size_tag.reason}`:'';
    sheet.rows.push([c.display_name, label, (fact.status === 'missing' ? '暂无已核实资料' : fact.value+(fact.status==='api_supported'?'（API资料，待独立核实）':fact.status==='demo_unreviewed'?'（首版画像，待独立复核）':''))+sizeNote, fact.entity || '—', fact.as_of || (fact.checked_at ? '统计时点未注明；资料日期 ' + fact.checked_at.slice(0, 10) : '—'), urls.join('\n') || '—']);
    if (urls.length === 1) sheet.links.push({row: sheet.rows.length + 1, column: 6, url: urls[0], label: urls[0]});
  }
  return sheet;
}

export function profileGaps(snapshot) {
  return snapshot.companies.flatMap(c => Object.keys(PROFILE_FIELDS).filter(f => c[f].status === 'missing').map(field => ({company_id: c.company_id, company: c.display_name, field})));
}
