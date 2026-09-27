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
  candidates: path.join(ROOT, 'datasets/recruitment-links/catalog/waiqi-source-candidates.json'),
  contexts: path.join(ROOT, 'shared/job-search-core/state/maintenance/waiqi-2026-09-20/zero-position-official-clean/duplicates-existing.json'),
  index: path.join(ROOT, 'datasets/company-research/reviews/waiqi-foreign-company-index.json'),
  artifacts: path.join(ROOT, 'shared/job-search-core/state/maintenance/waiqi-2026-09-20/waiqi-ownership-tagging'),
});

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const idOf = value => value == null ? '' : String(value).trim();
const uniq = values => [...new Set(values.filter(Boolean))];
const countsBy = (items, key) => Object.fromEntries([...new Set(items.map(item => item[key]))].sort().map(value => [value, items.filter(item => item[key] === value).length]));

export function extractWaiqiCompanyIds(value, found = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return found;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) extractWaiqiCompanyIds(item, found, seen);
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'waiqi_company_id') {
      const id = idOf(child);
      if (id) found.add(id);
    } else extractWaiqiCompanyIds(child, found, seen);
  }
  return found;
}

export function buildWaiqiForeignIndex(candidateDataset, checkedAt = candidateDataset?.checked_at || new Date().toISOString()) {
  const companies = (candidateDataset?.companies || []).map(company => {
    const isForeign = company.ownership_hint === '外企';
    return {
      waiqi_company_id: company.waiqi_company_id,
      display_name: company.display_name,
      aliases: company.aliases || [],
      waiqi_company_type: company.ownership_hint || null,
      ownership_tag: isForeign ? '外企' : null,
      status: isForeign ? 'verified' : 'not_external_proof',
      source_url: company.source_url || `https://waiqi.com/company/detail?id=${company.waiqi_company_id}`,
      checked_at: checkedAt,
    };
  });
  return {
    schema_version: 1,
    source: candidateDataset?.source || 'https://waiqi.com/company',
    checked_at: checkedAt,
    policy: '仅 Waiqi 公司详情明确标注“外企”时提供外企证明；“合资”及仅目录收录不作为外企证明。',
    counts: {
      companies: companies.length,
      explicit_foreign: companies.filter(item => item.status === 'verified').length,
      joint_venture_not_external_proof: companies.filter(item => item.waiqi_company_type === '合资').length,
    },
    companies,
  };
}

function addMatch(matches, companyId, waiqiId, method) {
  if (!companyId || !waiqiId) return;
  let byWaiqi = matches.get(companyId);
  if (!byWaiqi) matches.set(companyId, byWaiqi = new Map());
  let methods = byWaiqi.get(waiqiId);
  if (!methods) byWaiqi.set(waiqiId, methods = new Set());
  methods.add(method);
}

export function findRegistryMatches(registry, candidateDataset, strictContexts = []) {
  const registryIds = new Set((registry?.companies || []).map(company => company.company_id));
  const candidates = candidateDataset?.companies || [];
  const byWaiqiId = new Map(candidates.map(company => [idOf(company.waiqi_company_id), company]));
  const explicitForeignIds = new Set(candidates.filter(company => company.ownership_hint === '外企').map(company => idOf(company.waiqi_company_id)));
  const matches = new Map();

  for (const candidate of candidates) {
    const waiqiId = idOf(candidate.waiqi_company_id);
    if (!explicitForeignIds.has(waiqiId)) continue;
    for (const evidence of candidate.match_evidence || []) {
      if (!registryIds.has(evidence?.company_id)) continue;
      if ((evidence?.basis || []).includes('exact_normalized_name')) addMatch(matches, evidence.company_id, waiqiId, 'exact_normalized_name');
    }
  }

  for (const company of registry?.companies || []) {
    const sourceRecords = Array.isArray(company.recruitment_sources) ? company.recruitment_sources : [company];
    for (const waiqiId of extractWaiqiCompanyIds(sourceRecords)) {
      if (explicitForeignIds.has(waiqiId)) addMatch(matches, company.company_id, waiqiId, 'reviewed_source_provenance');
    }
  }

  for (const context of strictContexts || []) {
    const waiqiIds = uniq((context.waiqi_companies || []).map(item => idOf(item.waiqi_company_id))).filter(id => explicitForeignIds.has(id));
    if (!waiqiIds.length) continue;
    for (const existing of context.existing_sources || []) {
      if (!registryIds.has(existing?.company_id)) continue;
      for (const waiqiId of waiqiIds) addMatch(matches, existing.company_id, waiqiId, 'reviewed_strict_recruitment_context');
    }
  }

  return {matches, byWaiqiId};
}

const methodLabels = Object.freeze({
  exact_normalized_name: '精确名称',
  reviewed_source_provenance: '已核验招聘来源中的具体 Waiqi 公司 ID',
  reviewed_strict_recruitment_context: '已清洗的严格招聘上下文',
});

function priorClassification(row) {
  const {prior_classification, classification_basis, classification_authority, waiqi_company_ids, waiqi_match_methods, ...prior} = row;
  return prior;
}

export function applyWaiqiOwnership(registry, ownershipDataset, profileDataset, sizeDataset, candidateDataset, strictContexts = [], now = new Date().toISOString()) {
  const checkedAt = now.slice(0, 10);
  const {matches, byWaiqiId} = findRegistryMatches(registry, candidateDataset, strictContexts);
  const matchedIds = new Set(matches.keys());
  const registryById = new Map((registry.companies || []).map(company => [company.company_id, company]));
  const profiles = new Map((profileDataset?.companies || []).map(profile => [profile.company_id, profile]));
  const beforeOwners = new Map((ownershipDataset?.companies || []).map(owner => [owner.company_id, owner]));
  const matchedCompanies = [];
  const skippedSupplierAuthority = [];
  const skippedOfficialAuthority = [];
  const conflicts = [];

  const companies = (ownershipDataset?.companies || []).map(owner => {
    const byWaiqi = matches.get(owner.company_id);
    if (!byWaiqi) return owner;
    if (owner.classification_basis === 'supplier_company_nature_classification') {
      skippedSupplierAuthority.push({company_id: owner.company_id, display_name: owner.display_name, supplier_natures: owner.supplier_natures || [], current_tag: owner.ownership_tag});
      return owner;
    }
    if (owner.classification_basis === 'official_identity_outside_enterprise_ownership_taxonomy') {
      skippedOfficialAuthority.push({company_id: owner.company_id, display_name: owner.display_name, current_tag: owner.ownership_tag, current_status: owner.status});
      return owner;
    }
    const waiqiIds = [...byWaiqi.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN', {numeric: true}));
    const methods = uniq(waiqiIds.flatMap(id => [...byWaiqi.get(id)])).sort();
    const waiqiCompanies = waiqiIds.map(id => byWaiqiId.get(id)).filter(Boolean);
    const evidence = waiqiCompanies.map(company => ({
      url: company.source_url || `https://waiqi.com/company/detail?id=${company.waiqi_company_id}`,
      title: `Waiqi 公司页：${company.display_name}`,
      note: `Waiqi 公司详情明确标注公司性质为“外企”；通过${methods.map(method => methodLabels[method]).join('、')}与维护主体关联。`,
      checked_at: checkedAt,
    }));
    const changed = owner.ownership_tag !== '外企' || owner.status !== 'verified' || owner.classification_basis !== 'waiqi_explicit_foreign_company_type';
    const updated = {
      ...owner,
      ownership_tag: '外企',
      status: 'verified',
      reason: `Waiqi 公司详情明确将关联主体标注为“外企”；按维护规则，该明确标注作为外企定性依据。主体关联方式：${methods.map(method => methodLabels[method]).join('、')}。`,
      checked_at: checkedAt,
      evidence,
      classification_basis: 'waiqi_explicit_foreign_company_type',
      classification_authority: 'user_designated_waiqi_directory',
      waiqi_company_ids: waiqiIds.map(id => /^\d+$/.test(id) ? Number(id) : id),
      waiqi_match_methods: methods,
    };
    if (changed && !owner.prior_classification) updated.prior_classification = priorClassification(owner);
    if (owner.prior_classification) updated.prior_classification = owner.prior_classification;
    const detail = {company_id: owner.company_id, display_name: owner.display_name, previous_tag: owner.ownership_tag, changed, waiqi_company_ids: updated.waiqi_company_ids, match_methods: methods};
    matchedCompanies.push(detail);
    if (owner.ownership_tag !== '外企') conflicts.push({...detail, previous_status: owner.status, previous_reason: owner.reason});
    return updated;
  });

  const outputOwners = {...ownershipDataset, updated_at: now, companies};
  const missingOwnerIds = [...matchedIds].filter(id => !beforeOwners.has(id));
  if (missingOwnerIds.length) throw new Error(`Matched registry companies are missing ownership rows: ${missingOwnerIds.join(', ')}`);
  const problemsBefore = ownershipDatasetProblems(registry.companies || [], ownershipDataset);
  const ownershipProblems = ownershipDatasetProblems(registry.companies || [], outputOwners);
  const previousProblems = new Set(problemsBefore.map(item => `${item.company_id}\u0000${item.problem}`));
  const introducedProblems = ownershipProblems.filter(item => matchedIds.has(item.company_id) || !previousProblems.has(`${item.company_id}\u0000${item.problem}`));
  if (introducedProblems.length) throw new Error(`Waiqi ownership output introduced invalid records: ${JSON.stringify(introducedProblems.slice(0, 8))}`);

  const newOwners = new Map(companies.map(owner => [owner.company_id, owner]));
  const oldSizes = new Map((sizeDataset?.companies || []).map(size => [size.company_id, size]));
  const sizeCompanies = (registry.companies || []).map(company => {
    if (!matchedIds.has(company.company_id)) {
      const existing = oldSizes.get(company.company_id);
      if (!existing) throw new Error(`Missing size row for ${company.company_id}`);
      return existing;
    }
    return classifyCompanySize(company, newOwners.get(company.company_id), profiles.get(company.company_id), {now});
  });
  const sizeCounts = countsBy(sizeCompanies, 'label');
  const outputSizes = {...sizeDataset, model: SIZE_MODEL, updated_at: now, counts: sizeCounts, companies: sizeCompanies};
  const registryIds = new Set((registry.companies || []).map(company => company.company_id));
  if (companies.length !== registryIds.size || sizeCompanies.length !== registryIds.size || companies.some(item => !registryIds.has(item.company_id)) || sizeCompanies.some(item => !registryIds.has(item.company_id))) {
    throw new Error('Ownership or size output no longer has exact registry coverage');
  }

  return {ownership: outputOwners, sizes: outputSizes, matchedCompanies, conflicts, skippedSupplierAuthority, skippedOfficialAuthority, ownershipProblemsBefore: problemsBefore, ownershipProblemsAfter: ownershipProblems};
}

function parseArgs(argv) {
  const options = {...DEFAULTS, apply: false};
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

async function atomicWrite(file, text, expectedHash = null) {
  if (expectedHash !== null) {
    const current = await fs.readFile(file, 'utf8');
    if (sha256(current) !== expectedHash) throw new Error(`${file} changed while preparing update; rerun`);
  }
  const temporary = `${file}.waiqi-ownership-${process.pid}.tmp`;
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(temporary, text);
  if (expectedHash !== null) {
    const current = await fs.readFile(file, 'utf8');
    if (sha256(current) !== expectedHash) {
      await fs.unlink(temporary);
      throw new Error(`${file} changed before atomic rename; rerun`);
    }
  }
  await fs.rename(temporary, file);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const [registryText, ownershipText, sizesText, profilesText, candidatesText] = await Promise.all([
    fs.readFile(options.registry, 'utf8'), fs.readFile(options.ownership, 'utf8'), fs.readFile(options.sizes, 'utf8'), fs.readFile(options.profiles, 'utf8'), fs.readFile(options.candidates, 'utf8'),
  ]);
  let strictContexts = [];
  try { strictContexts = await readJson(options.contexts); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const registry = JSON.parse(registryText);
  const ownership = JSON.parse(ownershipText);
  const sizes = JSON.parse(sizesText);
  const profiles = JSON.parse(profilesText);
  const candidates = JSON.parse(candidatesText);
  const now = new Date().toISOString();
  const waiqiIndex = buildWaiqiForeignIndex(candidates, candidates.checked_at || now);
  const result = applyWaiqiOwnership(registry, ownership, profiles, sizes, candidates, strictContexts, now);
  const methodCounts = {};
  for (const row of result.matchedCompanies) for (const method of row.match_methods) methodCounts[method] = (methodCounts[method] || 0) + 1;
  const summary = {
    checked_at: now,
    apply: options.apply,
    policy: waiqiIndex.policy,
    directory: waiqiIndex.counts,
    registry_companies: registry.companies.length,
    waiqi_identity_matches: result.matchedCompanies.length + result.skippedSupplierAuthority.length + result.skippedOfficialAuthority.length,
    matched_registry_companies: result.matchedCompanies.length,
    changed_registry_companies: result.matchedCompanies.filter(row => row.changed).length,
    already_external: result.matchedCompanies.filter(row => row.previous_tag === '外企').length,
    overridden_non_external: result.conflicts.length,
    unmatched_registry_companies: registry.companies.length - result.matchedCompanies.length - result.skippedSupplierAuthority.length - result.skippedOfficialAuthority.length,
    match_method_company_counts: methodCounts,
    skipped_supplier_authority: result.skippedSupplierAuthority.length,
    skipped_official_authority: result.skippedOfficialAuthority.length,
    ownership_counts_before: countsBy(ownership.companies, 'ownership_tag'),
    ownership_counts_after: countsBy(result.ownership.companies, 'ownership_tag'),
    size_counts_after: result.sizes.counts,
    preexisting_ownership_problems_before: result.ownershipProblemsBefore.length,
    preexisting_ownership_problems_after: result.ownershipProblemsAfter.length,
  };
  await fs.mkdir(options.artifacts, {recursive: true});
  const matchedArtifact = options.apply ? 'matched-companies.json' : 'matched-companies.preview.json';
  const conflictsArtifact = options.apply ? 'conflicts-overridden.json' : 'conflicts-overridden.preview.json';
  await Promise.all([
    fs.writeFile(path.join(options.artifacts, options.apply ? 'apply-result.json' : 'preview.json'), JSON.stringify(summary, null, 2) + '\n'),
    fs.writeFile(path.join(options.artifacts, matchedArtifact), JSON.stringify(result.matchedCompanies, null, 2) + '\n'),
    fs.writeFile(path.join(options.artifacts, conflictsArtifact), JSON.stringify(result.conflicts, null, 2) + '\n'),
    fs.writeFile(path.join(options.artifacts, options.apply ? 'skipped-supplier-authority.json' : 'skipped-supplier-authority.preview.json'), JSON.stringify(result.skippedSupplierAuthority, null, 2) + '\n'),
    fs.writeFile(path.join(options.artifacts, options.apply ? 'skipped-official-authority.json' : 'skipped-official-authority.preview.json'), JSON.stringify(result.skippedOfficialAuthority, null, 2) + '\n'),
    fs.writeFile(path.join(options.artifacts, 'waiqi-foreign-company-index.preview.json'), JSON.stringify(waiqiIndex, null, 2) + '\n'),
  ]);
  if (options.apply) {
    const stamp = now.replaceAll(':', '-');
    const backup = path.join(options.artifacts, `backup-${stamp}`);
    await fs.mkdir(backup, {recursive: true});
    await Promise.all([
      fs.writeFile(path.join(backup, path.basename(options.ownership)), ownershipText),
      fs.writeFile(path.join(backup, path.basename(options.sizes)), sizesText),
    ]);
    try { await fs.copyFile(options.index, path.join(backup, path.basename(options.index))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await atomicWrite(options.ownership, JSON.stringify(result.ownership, null, 2) + '\n', sha256(ownershipText));
    await atomicWrite(options.sizes, JSON.stringify(result.sizes, null, 2) + '\n', sha256(sizesText));
    await atomicWrite(options.index, JSON.stringify(waiqiIndex, null, 2) + '\n');
  }
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
