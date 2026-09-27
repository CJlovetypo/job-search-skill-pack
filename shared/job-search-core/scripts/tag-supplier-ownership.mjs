import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {classifyCompanySize, SIZE_MODEL} from './lib/company-size.mjs';
import {ownershipDatasetProblems} from './lib/ownership.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DEFAULTS = Object.freeze({
  registry: path.join(ROOT, 'shared/job-search-core/assets/sources.json'),
  ownership: path.join(ROOT, 'datasets/company-research/inputs/company-ownership-tags.json'),
  sizes: path.join(ROOT, 'datasets/company-research/inputs/company-size-tags.json'),
  profiles: path.join(ROOT, 'datasets/company-research/inputs/company-profiles.json'),
  artifacts: path.join(ROOT, 'shared/job-search-core/state/maintenance/supplier-ownership-refresh-2026-09-20'),
  apply: false,
});

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const uniq = values => [...new Set(values.filter(Boolean))];
const countsBy = (items, key) => Object.fromEntries([...new Set(items.map(item => item[key]))].sort().map(value => [value, items.filter(item => item[key] === value).length]));
const decisiveMap = new Map([
  ['民营企业', '私企'],
  ['外企', '外企'],
  ['央国企', '国企'],
  ['国企', '国企'],
  ['央企', '国企'],
]);

function walkClassifications(row, output = [], seen = new Set()) {
  if (!row || typeof row !== 'object' || seen.has(row)) return output;
  seen.add(row);
  output.push(row);
  walkClassifications(row.prior_classification, output, seen);
  for (const item of row.classification_history || []) walkClassifications(item, output, seen);
  return output;
}

function cleanNature(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

export function extractSupplierNatures(row) {
  const values = [];
  for (const record of walkClassifications(row)) {
    for (const evidence of record.evidence || []) {
      const note = String(evidence?.note || '');
      const match = note.match(/源记录\s+natures\s*=\s*\[(.*?)\]/s);
      if (match) {
        try {
          const parsed = JSON.parse(`[${match[1]}]`);
          values.push(...parsed.map(cleanNature));
        } catch {
          values.push(...match[1].split(/[、，,]/).map(cleanNature));
        }
      }
    }
    const reason = String(record.reason || '');
    const hint = reason.match(/旧库供应商性质提示为“([^”]+)”/);
    if (hint) values.push(...hint[1].split(/[、，,]/).map(cleanNature));
  }
  return uniq(values);
}

export function resolveSupplierNatures(natures) {
  const mapped = uniq(natures.map(nature => decisiveMap.get(nature)));
  if (!mapped.length) return {action: 'unmapped', ownership_tag: null, mapped_tags: []};
  if (mapped.length > 1 || natures.some(nature => !decisiveMap.has(nature))) return {action: 'conflict', ownership_tag: '待核实', mapped_tags: mapped};
  return {action: 'classified', ownership_tag: mapped[0], mapped_tags: mapped};
}

function classificationSnapshot(row) {
  const {prior_classification, classification_history, ...snapshot} = row;
  return snapshot;
}

function supplierEvidence(owner, natures, checkedAt) {
  const records = walkClassifications(owner);
  const isPublic = item => { try { return ['http:', 'https:'].includes(new URL(item?.url).protocol); } catch { return false; } };
  const direct = records.flatMap(record => record.evidence || []).filter(item => isPublic(item) && /源记录\s+natures\s*=/.test(String(item.note || '')));
  const supplierRecordEvidence = records.filter(record => /旧库供应商性质提示|招聘数据源已为/.test(String(record.reason || '')))
    .flatMap(record => record.evidence || []).filter(isPublic);
  const existing = records.flatMap(record => record.evidence || []).filter(isPublic);
  const notWaiqi = item => { try { return new URL(item.url).hostname !== 'waiqi.com'; } catch { return false; } };
  const basis = direct.find(notWaiqi) || supplierRecordEvidence.find(notWaiqi) || existing.find(notWaiqi) || direct[0] || supplierRecordEvidence[0] || existing[0] || {url: 'https://scnk2250sha0.feishu.cn/base/DseGb8ZeQannZ1sAp8pcLB03n7e', title: `${owner.display_name} 旧库供应商记录`, note: '旧库供应商结构化记录。'};
  return [{
    url: basis.url,
    title: `旧库供应商公司性质：${owner.display_name}`,
    note: `源记录 natures=${JSON.stringify(natures)}；按维护规则，该结构化供应商公司性质字段直接映射最终标签。`,
    checked_at: checkedAt,
  }];
}

export function applySupplierOwnership(registry, ownershipDataset, profileDataset, sizeDataset, now = new Date().toISOString()) {
  const checkedAt = now.slice(0, 10);
  const profiles = new Map((profileDataset?.companies || []).map(profile => [profile.company_id, profile]));
  const registryById = new Map((registry?.companies || []).map(company => [company.company_id, company]));
  const beforeProblems = ownershipDatasetProblems(registry.companies || [], ownershipDataset);
  const refreshed = [], conflicts = [], unmapped = [];
  const companies = (ownershipDataset?.companies || []).map(owner => {
    const natures = extractSupplierNatures(owner);
    if (!natures.length) return owner;
    const resolution = resolveSupplierNatures(natures);
    if (resolution.action === 'unmapped') {
      unmapped.push({company_id: owner.company_id, display_name: owner.display_name, supplier_natures: natures, current_tag: owner.ownership_tag});
      return owner;
    }
    const status = resolution.action === 'conflict' ? 'verified_unresolved' : 'verified';
    const same = owner.classification_basis === 'supplier_company_nature_classification'
      && owner.ownership_tag === resolution.ownership_tag
      && owner.status === status
      && owner.classification_rule_version === '2026-09-20-supplier-v2'
      && JSON.stringify(owner.supplier_natures || []) === JSON.stringify(natures);
    const detail = {company_id: owner.company_id, display_name: owner.display_name, supplier_natures: natures, previous_tag: owner.ownership_tag, final_tag: resolution.ownership_tag, action: resolution.action, changed: !same};
    refreshed.push(detail);
    if (resolution.action === 'conflict') conflicts.push(detail);
    if (same) return owner;
    const history = [...(owner.classification_history || [])];
    const snapshot = classificationSnapshot(owner);
    const last = history.at(-1);
    if (owner.classification_basis !== 'supplier_company_nature_classification' && JSON.stringify(last) !== JSON.stringify(snapshot)) history.push(snapshot);
    const updated = {
      ...owner,
      ownership_tag: resolution.ownership_tag,
      status,
      reason: resolution.action === 'conflict'
        ? `旧库供应商结构化公司性质同时包含${natures.map(item => `“${item}”`).join('、')}，映射到多个最终标签，保留为待核实。`
        : `旧库供应商结构化公司性质标注为${natures.map(item => `“${item}”`).join('、')}；按维护规则直接映射为“${resolution.ownership_tag}”。`,
      checked_at: checkedAt,
      evidence: supplierEvidence(owner, natures, checkedAt),
      classification_basis: 'supplier_company_nature_classification',
      classification_authority: 'user_designated_legacy_supplier',
      classification_rule_version: '2026-09-20-supplier-v2',
      supplier_natures: natures,
      classification_history: history,
    };
    if (!owner.prior_classification) updated.prior_classification = snapshot;
    return updated;
  });
  const outputOwnership = {...ownershipDataset, updated_at: now, companies};
  const afterProblems = ownershipDatasetProblems(registry.companies || [], outputOwnership);
  const previousProblemKeys = new Set(beforeProblems.map(item => `${item.company_id}\u0000${item.problem}`));
  const touched = new Set(refreshed.map(item => item.company_id));
  const introduced = afterProblems.filter(item => touched.has(item.company_id) || !previousProblemKeys.has(`${item.company_id}\u0000${item.problem}`));
  if (introduced.length) throw new Error(`Supplier refresh introduced invalid ownership rows: ${JSON.stringify(introduced.slice(0, 8))}`);
  const owners = new Map(companies.map(owner => [owner.company_id, owner]));
  const oldSizes = new Map((sizeDataset?.companies || []).map(size => [size.company_id, size]));
  const changedIds = new Set(refreshed.filter(item => item.changed).map(item => item.company_id));
  const sizeCompanies = (registry.companies || []).map(company => changedIds.has(company.company_id)
    ? classifyCompanySize(company, owners.get(company.company_id), profiles.get(company.company_id), {now})
    : oldSizes.get(company.company_id));
  if (companies.length !== registryById.size || sizeCompanies.length !== registryById.size || sizeCompanies.some(item => !item)) throw new Error('Ownership or size coverage differs from registry');
  const outputSizes = {...sizeDataset, model: SIZE_MODEL, updated_at: now, counts: countsBy(sizeCompanies, 'label'), companies: sizeCompanies};
  return {ownership: outputOwnership, sizes: outputSizes, refreshed, conflicts, unmapped, beforeProblems, afterProblems};
}

function parseArgs(argv) {
  const options = {...DEFAULTS};
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--') && arg.includes('=')) {
      const [key, ...rest] = arg.slice(2).split('=');
      if (!(key in options)) throw new Error(`Unknown option: --${key}`);
      options[key] = path.resolve(rest.join('='));
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function atomicWrite(file, text, expectedHash) {
  const current = await fs.readFile(file, 'utf8');
  if (sha256(current) !== expectedHash) throw new Error(`${file} changed while preparing refresh`);
  const temporary = `${file}.supplier-${process.pid}.tmp`;
  await fs.writeFile(temporary, text, {flag: 'wx'});
  if (sha256(await fs.readFile(file, 'utf8')) !== expectedHash) { await fs.unlink(temporary); throw new Error(`${file} changed before atomic rename`); }
  await fs.rename(temporary, file);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const [registryText, ownershipText, sizesText, profilesText] = await Promise.all([
    fs.readFile(options.registry, 'utf8'), fs.readFile(options.ownership, 'utf8'), fs.readFile(options.sizes, 'utf8'), fs.readFile(options.profiles, 'utf8'),
  ]);
  const registry = JSON.parse(registryText), ownership = JSON.parse(ownershipText), sizes = JSON.parse(sizesText), profiles = JSON.parse(profilesText);
  const now = new Date().toISOString();
  const result = applySupplierOwnership(registry, ownership, profiles, sizes, now);
  const summary = {
    checked_at: now,
    apply: options.apply,
    registry_companies: registry.companies.length,
    companies_with_supplier_nature: result.refreshed.length + result.unmapped.length,
    refreshed_companies: result.refreshed.length,
    changed_companies: result.refreshed.filter(item => item.changed).length,
    supplier_conflicts_kept_pending: result.conflicts.length,
    supplier_natures_unmapped: result.unmapped.length,
    final_supplier_tags: countsBy(result.refreshed, 'final_tag'),
    ownership_counts_before: countsBy(ownership.companies, 'ownership_tag'),
    ownership_counts_after: countsBy(result.ownership.companies, 'ownership_tag'),
    size_counts_after: result.sizes.counts,
    ownership_problems_before: result.beforeProblems.length,
    ownership_problems_after: result.afterProblems.length,
  };
  await fs.mkdir(options.artifacts, {recursive: true});
  const suffix = options.apply ? '' : '.preview';
  await Promise.all([
    fs.writeFile(path.join(options.artifacts, options.apply ? 'apply-result.json' : 'preview.json'), JSON.stringify(summary, null, 2) + '\n'),
    fs.writeFile(path.join(options.artifacts, `refreshed-companies${suffix}.json`), JSON.stringify(result.refreshed, null, 2) + '\n'),
    fs.writeFile(path.join(options.artifacts, `supplier-conflicts${suffix}.json`), JSON.stringify(result.conflicts, null, 2) + '\n'),
    fs.writeFile(path.join(options.artifacts, `unmapped-supplier-natures${suffix}.json`), JSON.stringify(result.unmapped, null, 2) + '\n'),
  ]);
  if (options.apply) {
    const backup = path.join(options.artifacts, `backup-${now.replaceAll(':', '-')}`);
    await fs.mkdir(backup, {recursive: true});
    await Promise.all([
      fs.writeFile(path.join(backup, path.basename(options.ownership)), ownershipText, {flag: 'wx'}),
      fs.writeFile(path.join(backup, path.basename(options.sizes)), sizesText, {flag: 'wx'}),
    ]);
    await atomicWrite(options.ownership, JSON.stringify(result.ownership, null, 2) + '\n', sha256(ownershipText));
    await atomicWrite(options.sizes, JSON.stringify(result.sizes, null, 2) + '\n', sha256(sizesText));
  }
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
