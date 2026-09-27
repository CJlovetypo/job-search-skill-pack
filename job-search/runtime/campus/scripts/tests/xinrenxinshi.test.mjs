import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { collectXinrenxinshi } from '../lib/providers-xinrenxinshi.mjs';

const testRoot = fileURLToPath(new URL('../../artifacts/deep-source-review/software/production-smoke/tests/', import.meta.url));
const source = { company_id: 'test-xinren', display_name: 'Test company', primary_entry_url: 'https://example.test/recruitGate/list',
  public_bootstrap_requests: [{ url: 'https://example.test/recruitment/service/employee/ajax-gate-get-info-by-token?encryptToken=public-portal', method: 'GET' }] };
const description = '&lt;p&gt;岗位职责：负责企业产品需求研究、产品设计以及项目协调交付，推动团队持续迭代与客户业务发展。&lt;/p&gt;&lt;p&gt;任职要求：本科及以上学历，具备良好的沟通、逻辑分析和团队协作能力，能够独立完成业务调研。&lt;/p&gt;';
const job = (id, overrides = {}) => ({ jobId: id, name: '产品管培生', hireTypeDesc: '正式', workCity: '广州市', jobDesc: description, ...overrides });
const list = (jobs, total = jobs.length) => ({ code: 0, data: { data: jobs, totalNum: total } });

async function run(t, handler, options = {}) {
  await mkdir(testRoot, { recursive: true });
  const evidenceDir = await mkdtemp(path.join(testRoot, 'case-'));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const request = { url: String(url), body: new URLSearchParams(init.body || ''), method: init.method };
    calls.push(request);
    if (request.url.includes('ajax-gate-get-info-by-token')) return Response.json({ code: 0, data: { companyId: 'company', portalId: 'portal' } });
    const response = await handler(request);
    return response instanceof Response ? response : Response.json(response);
  });
  const result = await collectXinrenxinshi(source, { mode: 'list', maxPages: 5, evidenceDir, ...options });
  return { result, calls };
}

test('list mode retains complete JSON bodies, unknown campus type, and the observed listing URL', async t => {
  const { result, calls } = await run(t, q => list(q.body.get('page') === '1' ? [job('a')] : [], 1));
  assert.equal(result.coverage.status, 'complete');
  assert.equal(result.coverage.pages, 2);
  assert.equal(result.jobs[0].body_complete, true);
  assert.equal(result.jobs[0].formal_status, 'unknown');
  assert.equal(result.jobs[0].job_url_kind, 'official_listing');
  assert.equal(result.jobs[0].official_url, source.primary_entry_url);
  assert.match(result.jobs[0].description, /岗位职责/);
  assert.ok(!result.jobs[0].description.includes('&lt;'));
  assert.ok(!calls.some(q => q.url.includes('job-detail')));
});

test('one failed detail preserves its list row and does not discard another successful detail', async t => {
  const { result } = await run(t, q => {
    if (q.url.includes('job-detail')) {
      if (q.body.get('jobId') === 'a') throw new Error('Simulated transport failure');
      return { code: 0, data: job('b') };
    }
    return list(q.body.get('page') === '1' ? [job('a', { jobDesc: '列表摘要' }), job('b', { jobDesc: '列表摘要' })] : [], 2);
  }, { mode: 'full' });
  assert.equal(result.jobs.length, 2);
  assert.equal(result.jobs[0].body_complete, false);
  assert.match(result.jobs[0].detail_error, /Simulated transport failure/);
  assert.equal(result.jobs[1].body_complete, true);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.list_complete, true);
  assert.equal(result.coverage.details_failed, 1);
});

test('repeated pages stay partial and retain unique jobs', async t => {
  const { result } = await run(t, () => list([job('a')], 2));
  assert.equal(result.jobs.length, 1);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.reason, 'repeated_page_no_new_ids');
  assert.equal(result.coverage.page_evidence[1].new_ids, 0);
});

test('a changed server total cannot produce a complete result', async t => {
  const { result } = await run(t, q => q.body.get('page') === '1' ? list([job('a')], 1) : list([job('b')], 2));
  assert.equal(result.jobs.length, 2);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.reason, 'server_total_changed_during_collection');
});

test('a later list HTTP error preserves earlier rows', async t => {
  const { result } = await run(t, q => q.body.get('page') === '1' ? list([job('a')], 3) : new Response('Unavailable', { status: 503 }));
  assert.equal(result.jobs.length, 1);
  assert.equal(result.coverage.status, 'partial');
  assert.match(result.coverage.reason, /HTTP 503/);
});

test('duplicate IDs within a page are reported without duplicating jobs', async t => {
  const { result } = await run(t, () => list([job('a'), job('a')], 2));
  assert.equal(result.jobs.length, 1);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.reason, 'duplicate_ids_within_page');
});

test('mismatched detail JSON does not erase an already complete list body', async t => {
  const { result } = await run(t, q => {
    if (q.url.includes('job-detail')) return { code: 0, data: job('wrong-id', { jobDesc: '' }) };
    return list(q.body.get('page') === '1' ? [job('a')] : [], 1);
  }, { mode: 'full' });
  assert.equal(result.jobs[0].job_id, 'a');
  assert.equal(result.jobs[0].body_complete, true);
  assert.equal(result.coverage.status, 'partial');
  assert.match(result.jobs[0].detail_error, /job ID differs/);
});

test('a sparse detail preserves list body and updates its employment metadata with separate evidence', async t => {
  const { result } = await run(t, q => {
    if (q.url.includes('job-detail')) return { code: 0, data: job('a', { jobDesc: '', hireTypeDesc: '实习' }) };
    return list(q.body.get('page') === '1' ? [job('a')] : [], 1);
  }, { mode: 'full' });
  assert.equal(result.jobs[0].body_complete, true);
  assert.equal(result.jobs[0].formal_status, 'internship');
  assert.equal(result.jobs[0].raw_metadata.body_from_list, true);
  assert.notEqual(result.jobs[0].raw_file, result.jobs[0].raw_metadata.detail_raw_file);
});

test('successful JSON without complete duties and requirements stays partial in full mode', async t => {
  const incomplete = job('a', { jobDesc: '任职要求：本科及以上学历，具备良好的沟通、逻辑分析和团队协作能力，能够独立完成业务调研。' });
  const { result } = await run(t, q => q.url.includes('job-detail')
    ? { code: 0, data: incomplete } : list(q.body.get('page') === '1' ? [incomplete] : [], 1), { mode: 'full' });
  assert.equal(result.coverage.list_complete, true);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.incomplete_bodies, 1);
  assert.equal(result.jobs[0].body_complete, false);
});

test('internship metadata conflicting with explicit formal wording remains unknown', async t => {
  const { result } = await run(t, q => list(q.body.get('page') === '1' ? [job('a', {
    name: '产品实习生', hireTypeDesc: '实习', jobDesc: '此岗位属于秋招正式岗，只考虑短期实习的同学请谨慎投递。' + description,
  })] : [], 1));
  assert.equal(result.jobs[0].formal_status, 'unknown');
  assert.match(result.jobs[0].recruitment_evidence.type_conflict, /conflicts/);
});
