import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {classifyCompanySize} from './lib/company-size.mjs';

// Append unknown placeholders only. Existing facts and their order are immutable.
export function appendMissingTags(registry, ownership, size, now = new Date().toISOString()) {
  for (const [name, document] of Object.entries({registry, ownership, size})) {
    assert(Array.isArray(document.companies), `${name}: companies must be an array`);
    const ids = document.companies.map(c => c.company_id);
    assert(ids.every(id => typeof id === 'string' && id), `${name}: invalid ID`);
    assert.equal(new Set(ids).size, ids.length, `${name}: duplicate IDs`);
  }
  const owners = new Map(ownership.companies.map(c => [c.company_id, c]));
  const sizes = new Set(size.companies.map(c => c.company_id));
  const ownershipAdded = [], sizeAdded = [];
  for (const company of registry.companies) {
    if (!owners.has(company.company_id)) {
      const item = {company_id:company.company_id, display_name:company.display_name,
        ownership_tag:'待核实', status:'unknown', reason:'新增招聘主体的控制关系尚未核查', evidence:[], checked_at:null};
      ownershipAdded.push(item);
      owners.set(company.company_id, item);
    }
    if (!sizes.has(company.company_id)) {
      // No profile/aggregator data is used, even if another index has facts.
      const item = classifyCompanySize(company, undefined, undefined, {now});
      sizeAdded.push(item);
    }
  }
  const nextOwnership = structuredClone(ownership), nextSize = structuredClone(size);
  if (ownershipAdded.length) {
    nextOwnership.companies.push(...ownershipAdded);
    nextOwnership.updated_at = now;
  }
  if (sizeAdded.length) {
    nextSize.companies.push(...sizeAdded);
    nextSize.updated_at = now;
    nextSize.counts = nextSize.companies.reduce((counts, c) => {
      counts[c.label] = (counts[c.label] || 0) + 1;
      return counts;
    }, {});
  }
  assert.deepEqual(nextOwnership.companies.slice(0, ownership.companies.length), ownership.companies);
  assert.deepEqual(nextSize.companies.slice(0, size.companies.length), size.companies);
  return {ownership:nextOwnership, size:nextSize, ownershipAdded, sizeAdded};
}

export function appendMissingProfileTags(registry, document, kind, now) {
  assert(['business', 'profiles'].includes(kind));
  const ids = new Set(document.companies.map(c => c.company_id));
  assert.equal(ids.size, document.companies.length, `${kind}: duplicate IDs`);
  const emptyFact = () => ({value:'', status:'missing', entity:'', as_of:'', checked_at:'', evidence:[]});
  const added = registry.companies.filter(c => !ids.has(c.company_id)).map(c => ({
    company_id:c.company_id, display_name:c.display_name,
    ...(kind === 'business' ? {business_tags:[], business_summary:'', status:'unknown', evidence:[], reason:'招聘主体已核实，主营业务标签待公开资料补核'} : {
      business:emptyFact(), workforce:emptyFact(), capital:emptyFact(),
    }),
  }));
  const next = structuredClone(document);
  if (added.length) {next.companies.push(...added); next.updated_at = now;}
  assert.deepEqual(next.companies.slice(0, document.companies.length), document.companies);
  return {next, added};
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const files = {
    registry:path.join(root, 'shared/job-search-core/assets/sources.json'),
    ownership:path.join(root, 'datasets/company-research/inputs/company-ownership-tags.json'),
    size:path.join(root, 'datasets/company-research/inputs/company-size-tags.json'),
    business:path.join(root, 'datasets/company-research/inputs/company-business-tags.json'),
    profiles:path.join(root, 'datasets/company-research/inputs/company-profiles.json'),
  };
  const raw = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await fs.readFile(file, 'utf8')])));
  const docs = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, JSON.parse(value)]));
  const now = new Date().toISOString(), plan = appendMissingTags(docs.registry, docs.ownership, docs.size, now);
  const metadataKeys = ['ownership', 'size', 'business', 'profiles'];
  for (const kind of ['business', 'profiles']) {
    const supplement = appendMissingProfileTags(docs.registry, docs[kind], kind, now);
    plan[kind] = supplement.next;
    plan[kind + 'Added'] = supplement.added;
  }
  const ids = docs.registry.companies.map(c => c.company_id).sort();
  const cities = {};
  for (const mode of ['campus', 'internship', 'social']) {
    const doc = JSON.parse(await fs.readFile(path.join(root, `${mode}-job-fit/data/company-city-index.json`), 'utf8'));
    assert.deepEqual(doc.companies.map(c => c.company_id).sort(), ids, `${mode}: city index IDs differ`);
    cities[mode] = doc.companies.length;
  }
  let backupDirectory = null;
  const apply = process.argv.includes('--apply');
  if (apply && metadataKeys.some(key => plan[key + 'Added'].length)) {
    backupDirectory = path.join(root, 'shared/job-search-core/state/maintenance/metadata-placeholder-backups', now.replaceAll(':', '-'));
    await fs.mkdir(backupDirectory, {recursive:true});
    for (const key of metadataKeys) await fs.writeFile(path.join(backupDirectory, path.basename(files[key])), raw[key], {flag:'wx'});
    for (const key of Object.keys(files)) assert.equal(await fs.readFile(files[key], 'utf8'), raw[key], `${key}: changed concurrently`);
    for (const key of metadataKeys) {
      if (!plan[key + 'Added'].length) continue;
      assert.equal(await fs.readFile(files.registry, 'utf8'), raw.registry, 'registry: changed concurrently');
      assert.equal(await fs.readFile(files[key], 'utf8'), raw[key], `${key}: changed concurrently`);
      const temp = files[key] + `.seed-${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(plan[key], null, 2) + '\n', {flag:'wx'});
      await fs.rename(temp, files[key]);
      const saved = JSON.parse(await fs.readFile(files[key], 'utf8'));
      assert.deepEqual(saved.companies.slice(0, docs[key].companies.length), docs[key].companies);
    }
  }
  console.log(JSON.stringify({apply, ownership_added:plan.ownershipAdded.length, size_added:plan.sizeAdded.length,
    business_added:plan.businessAdded.length, profiles_added:plan.profilesAdded.length,
    existing_rows_preserved:true, cities, backup_directory:backupDirectory}, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => {console.error(error); process.exitCode = 1;});
