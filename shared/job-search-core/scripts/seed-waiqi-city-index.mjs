import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {PACK_ROOT, MODE_ROOTS} from '../runtime-context.mjs';
import {INDUSTRIES} from './lib/industry-routing.mjs';
import {planWaiqiIntegration, sourceKey} from './lib/waiqi-integration.mjs';
import {officialArchivedJob, seedCompanyCityTag} from './lib/waiqi-city-seed.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const save = async (file, value) => { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n'); };
const missingRead = async file => { try { return await read(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

export async function main(args = process.argv.slice(2)) {
  const apply = args.includes('--apply');
  const root = path.resolve(args.find(x => x.startsWith('--input='))?.slice(8) || path.join(PACK_ROOT, 'shared/job-search-core/state/maintenance/waiqi-2026-09-20'));
  if (args.some(x => x !== '--apply' && !x.startsWith('--input='))) throw Error('Usage: seed-waiqi-city-index.mjs [--input=waiqi-artifact-directory] [--apply]');
  const out = path.join(root, 'city-seed'), registryFile = path.join(PACK_ROOT, 'shared/job-search-core/assets/sources.json');
  const before = await fs.readFile(registryFile, 'utf8'), inputs = [];
  for (const folder of ['official-verification', 'official-greenhouse-verification', 'official-domestic-verification', 'official-zero-api-verification', 'official-zero-search-verification', 'routing-expansion-admission']) {
    const file = path.join(root, folder, 'admitted.json');
    for (const item of await missingRead(file) || []) inputs.push({item, file});
  }
  const plan = planWaiqiIntegration(JSON.parse(before), inputs, INDUSTRIES.map(x => x.id));
  if (apply && plan.added.length) throw Error('Apply the reviewed source integration first; city seeding will not write IDs absent from the official registry');
  const ownerByKey = new Map();
  for (const company of plan.registry.companies) for (const source of company.recruitment_sources?.length ? company.recruitment_sources : [company]) {
    try { ownerByKey.set(sourceKey(source), company); } catch {}
  }
  const observations = new Map(), failures = [], sourceMapping = [], archiveRows = [];
  for (const {item: source, file} of inputs) {
    if (plan.rejected.some(r => r.file === file && r.name === source.display_name)) continue;
    const company = ownerByKey.get(sourceKey(source));
    if (!company) { failures.push({source_id: source.source_id, reason: 'no reviewed final source owner'}); continue; }
    sourceMapping.push({source_id: source.source_id, archive_company_id: source.company_id, company_id: company.company_id, display_name: company.display_name});
    if (!observations.has(company.company_id)) observations.set(company.company_id, {company, rows: []});
    let files = [];
    if (source.source_verification?.proof_directory) {
      const proof = path.join(source.source_verification.proof_directory, 'verification.json');
      const record = await missingRead(proof);
      if (Array.isArray(record?.jobs) || record?.sample_job) files.push(proof);
      else if (record) {
        files.push(...(record.attempts || []).flatMap(a => [a.result_file, a.capability_result_file]).filter(Boolean));
        if (!files.length) files.push(...[record.result_file, record.capability_result_file].filter(Boolean));
      }
    }
    if(source.verification_status==='verified_public_list_only'&&source.source_verification?.proof_directory){
      const listResult=path.join(source.source_verification.proof_directory,'result.json');
      if(await missingRead(listResult))files.push(listResult);
    }
    if (source.api_verification?.evidence_file) files.push(path.join(path.dirname(source.api_verification.evidence_file), 'collection.json'));
    files = [...new Set(files)];
    if (source.source_origin === 'waiqi-zero-position-empty-website-search-20260920' && Array.isArray(source.verified_samples)) files = [];
    if (!files.length && Array.isArray(source.verified_samples) && source.verified_samples.length) {
      const jobs = [];
      for (const job of source.verified_samples) {
        if (!officialArchivedJob(job)) continue;
        try { await fs.access(job.raw_file); } catch { failures.push({source_id: source.source_id, job_id: job.job_id, reason: 'missing raw API evidence', file: job.raw_file}); continue; }
        jobs.push(job);
      }
      observations.get(company.company_id).rows.push({source, result: {checked_at: source.verified_at || source.api_verified_at, jobs, coverage: source.source_verification?.coverage}, file});
      archiveRows.push(...jobs.map(job => ({...job, final_company_id: company.company_id, archive_source_id: source.source_id, archive_result_file: file})));
      continue;
    }
    if (!files.length) failures.push({source_id: source.source_id, reason: 'no normalized official result archive located'});
    for (const resultFile of files) {
      const result = await missingRead(resultFile);
      const normalizedJobs = Array.isArray(result?.jobs) ? result.jobs : result?.sample_job ? [result.sample_job] : null;
      if (!normalizedJobs) { failures.push({source_id: source.source_id, file: resultFile, reason: 'missing normalized official jobs'}); continue; }
      const jobs = [];
      for (const job of normalizedJobs) {
        if (!officialArchivedJob(job)) continue;
        try { await fs.access(job.raw_file); } catch { failures.push({source_id: source.source_id, job_id: job.job_id, reason: 'missing raw API evidence', file: job.raw_file}); continue; }
        jobs.push(job);
      }
      observations.get(company.company_id).rows.push({source, result: {...result, jobs}, file: resultFile});
      archiveRows.push(...jobs.map(job => ({...job, final_company_id: company.company_id, archive_source_id: source.source_id, archive_result_file: resultFile})));
    }
  }
  await fs.mkdir(out, {recursive: true});
  await fs.writeFile(path.join(out, 'official-jobs.jsonl'), archiveRows.map(row => JSON.stringify(row)).join('\n') + (archiveRows.length ? '\n' : ''));
  const indexWrites = [], modes = {};
  for (const [mode, skill] of Object.entries(MODE_ROOTS)) {
    const skillRoot = path.join(PACK_ROOT, skill), indexFile = path.join(skillRoot, 'company-city-index.json');
    let indexText = null; try { indexText = await fs.readFile(indexFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const index = indexText ? JSON.parse(indexText) : {schema_version: 1, companies: []};
    const previous = new Map(index.companies.map(c => [c.company_id, c])), updates = [], rows = [];
    for (const {company, rows: sourceRows} of observations.values()) {
      const resultFile = path.join(out, mode, company.company_id + '.json');
      const seeded = seedCompanyCityTag(company, sourceRows, previous.get(company.company_id), mode, path.relative(skillRoot, resultFile).replaceAll('\\', '/'));
      // Archive the exact post-review, post-reconciliation jobs used by city admission.
      await save(resultFile, seeded.result);
      if (seeded.needsUpdate) updates.push(seeded.tag);
      rows.push({company_id: company.company_id, display_name: company.display_name, update: seeded.needsUpdate,
        observed_target_jobs: seeded.tag.target_jobs_observed, cities: seeded.tag.cities,
        added_cities: seeded.tag.cities.filter(city => !previous.get(company.company_id)?.cities?.includes(city)),
        unknown_location_jobs: seeded.tag.unknown_location_jobs, uncertain_type_or_status_jobs: seeded.tag.uncertain_type_or_status_jobs});
    }
    const replacements = new Map(updates.map(c => [c.company_id, c]));
    const next = {...index, search_mode: mode, companies: index.companies.map(c => replacements.get(c.company_id) || c)};
    for (const update of updates) if (!previous.has(update.company_id)) next.companies.push(update);
    if (updates.length) next.updated_at = new Date().toISOString();
    await save(path.join(out, mode + '-patch.json'), {companies: updates});
    modes[mode] = {changed_companies: updates.length, companies_with_new_cities: rows.filter(r => r.added_cities.length).length,
      new_city_assignments: rows.reduce((n, r) => n + r.added_cities.length, 0), target_jobs_observed: rows.reduce((n, r) => n + r.observed_target_jobs, 0), rows};
    indexWrites.push({indexFile, indexText, next, updates: updates.length});
  }
  const summary = {checked_at: new Date().toISOString(), apply, registry_sha256: hash(before),
    source_integration_pending: plan.added.length, mapped_sources: sourceMapping.length, companies: observations.size,
    archived_official_jobs: archiveRows.length, source_mapping: sourceMapping, failures, rejected_sources: plan.rejected, modes};
  await save(path.join(out, apply ? 'apply-plan.json' : 'plan.json'), summary);
  if (apply) {
    if (await fs.readFile(registryFile, 'utf8') !== before) throw Error('Source registry changed during city seed; rerun');
    for (const entry of indexWrites) {
      let latest = null; try { latest = await fs.readFile(entry.indexFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (latest !== entry.indexText) throw Error('City index changed during seed; rerun: ' + entry.indexFile);
    }
    for (const entry of indexWrites.filter(x => x.updates)) {
      if (entry.indexText != null) await fs.writeFile(path.join(out, path.basename(path.dirname(path.dirname(entry.indexFile))) + '-before-' + Date.now() + '.json'), entry.indexText);
      const temporary = entry.indexFile + '.waiqi-seed-' + process.pid + '.tmp';
      await save(temporary, entry.next);
      let latest = null; try { latest = await fs.readFile(entry.indexFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (latest !== entry.indexText || await fs.readFile(registryFile, 'utf8') !== before) {
        await fs.unlink(temporary); throw Error('Registry or city index changed before atomic update; rerun');
      }
      await fs.rename(temporary, entry.indexFile);
    }
    await save(path.join(out, 'apply-result.json'), {...summary, applied: true});
  }
  console.log(JSON.stringify({...summary, source_mapping: undefined, modes: Object.fromEntries(Object.entries(modes).map(([mode, data]) => [mode, {...data, rows: undefined}]))}, null, 2));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
