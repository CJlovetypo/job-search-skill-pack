import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {auditDiscoveryCandidates} from './lib/waiqi-capability-audit.mjs';

const read = file => fs.readFile(file, 'utf8').then(JSON.parse);
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');

export async function auditOfficialDiscovery(discoveryDirectory, outputDirectory = path.join(discoveryDirectory, 'capability-review')) {
  const directory = path.resolve(discoveryDirectory), output = path.resolve(outputDirectory);
  const candidates = await read(path.join(directory, 'verified-api-candidates.json'));
  const registry = await read(path.resolve('shared/job-search-core/assets/sources.json'));
  const result = await auditDiscoveryCandidates(candidates, registry, file => read(path.resolve(file)));
  await fs.mkdir(output, {recursive: true});
  const pending = result.rows.filter(row => !row.source_key_already_registered);
  const zero = pending.filter(row => row.capability_state === 'zero_api_pending_identity');
  const positive = pending.filter(row => row.capability_state === 'positive_list_only_pending_full_jd');
  const reviewable = pending.filter(row => row.capability_state === 'positive_full_jd_reviewable');
  const blocked = pending.filter(row => row.identity_conflict || row.capability_state === 'unverified_pending');
  const summary = {
    generated_at: new Date().toISOString(), candidate_rows: candidates.length, distinct_formal_source_keys: result.rows.length,
    already_registered: result.rows.filter(row => row.source_key_already_registered).length,
    new_source_keys: pending.length, zero_api_pending_identity: zero.length,
    positive_list_only_pending_full_jd: positive.length, positive_full_jd_reviewable: reviewable.length,
    blocked_or_unverified: blocked.length, invalid_source_keys: result.invalid.length,
    policy: 'Positive APIs require at least one explicitly verified complete JD. Empty APIs use verified_api_zero_jobs only after official employer identity review. Automatic identity hints never admit a source.',
  };
  await Promise.all([
    write(path.join(output, 'summary.json'), summary),
    write(path.join(output, 'identity-review-template.json'), pending),
    write(path.join(output, 'zero-api-identity-review.json'), zero),
    write(path.join(output, 'positive-list-only-pending.json'), positive),
    write(path.join(output, 'positive-full-jd-reviewable.json'), reviewable),
    write(path.join(output, 'blocked-or-unverified.json'), blocked),
    write(path.join(output, 'invalid-source-keys.json'), result.invalid),
  ]);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [discoveryDirectory, outputDirectory] = process.argv.slice(2);
  if (!discoveryDirectory) throw Error('Usage: node audit-waiqi-official-discovery.mjs discovery-directory [output-directory]');
  const protectedPaths = ['shared/job-search-core/assets/sources.json', 'shared/job-search-core/data/recruitment/campus/company-city-index.json'].map(file => path.resolve(file));
  if (outputDirectory && protectedPaths.includes(path.resolve(outputDirectory))) throw Error('Audit output cannot overwrite a formal source or data index');
  console.log(JSON.stringify(await auditOfficialDiscovery(discoveryDirectory, outputDirectory), null, 2));
}
