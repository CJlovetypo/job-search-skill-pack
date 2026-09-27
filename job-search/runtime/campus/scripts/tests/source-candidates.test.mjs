import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {queryCandidates, discoveryCandidates, recruitmentUrls, main} from '../../../../../shared/job-search-core/scripts/source-candidates.mjs';

const company = {waiqi_company_id: 123, display_name: '测试公司', aliases: ['ACME'], industry_hint: '科技', ownership_hint: '外资', status: 'pending', matched_company_ids: ['known-1'], source_url: 'https://waiqi.com/company/123', recruitment_links: [{url: 'https://example.test/jobs#/index?id=123'}, 'https://example.test/jobs#/index?id=123', 'javascript:alert(1)']};
const dataset = {companies: [company, {...company, waiqi_company_id: 456, display_name: '无入口公司', aliases: [], matched_company_ids: [], recruitment_links: []}]};

test('maintenance search includes aliases, hint filters and unmatched companies without admitting sources', () => {
  assert.deepEqual(queryCandidates(dataset, {query: 'acme', companyId: 'known-1', industry: '科技', ownership: '外资', status: 'pending'}), [company]);
  assert.equal(queryCandidates(dataset).length, 2);
  assert.equal(queryCandidates(dataset, {hasRecruitment: true}).length, 1);
  assert.equal(queryCandidates(dataset, {status: 'verified'}).length, 0);
});

test('verification export preserves tenant fragments and provenance without treating a matched ID as confirmed identity', () => {
  const before = structuredClone(dataset);
  const rows = discoveryCandidates(dataset.companies);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company_id, 'waiqi-123');
  assert.deepEqual(rows[0].entry_urls, ['https://example.test/jobs#/index?id=123']);
  assert.equal(rows[0].provenance.identity_verified, false);
  assert.deepEqual(rows[0].provenance.matched_company_ids, ['known-1']);
  assert.deepEqual(rows[0].industry_tags, []);
  assert.deepEqual(dataset, before);
  assert.deepEqual(recruitmentUrls({recruitment_links: [{url: 'ftp://example.test'}, null, 'bad']}), []);
  assert.throws(() => discoveryCandidates([{...company, waiqi_company_id: '../escape'}]), /unsafe/);
});

test('CLI refuses overwriting either candidate input or admitted sources', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'waiqi-candidates-'));
  try {
    const input = path.join(folder, 'fixture.json');
    await fs.writeFile(input, JSON.stringify(dataset));
    for (const output of [input, path.join(folder, 'sources.json'), path.join(folder, 'waiqi-source-candidates.json')]) {
      await assert.rejects(main(['export-discovery', '--input=' + input, '--output=' + output]), /must not overwrite/);
    }
    assert.deepEqual(JSON.parse(await fs.readFile(input, 'utf8')), dataset);
  } finally { await fs.rm(folder, {recursive: true, force: true}); }
});
