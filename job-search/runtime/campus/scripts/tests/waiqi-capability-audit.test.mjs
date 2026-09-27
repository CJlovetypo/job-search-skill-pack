import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {auditDiscoveryCandidates, formalSourceFromDiscovery} from '../../../../../shared/job-search-core/scripts/lib/waiqi-capability-audit.mjs';
import {sourceKey} from '../../../../../shared/job-search-core/scripts/lib/waiqi-integration.mjs';

const hash = 'b'.repeat(64);
function candidate({id, name, provider, entry, config, file, jobs, total, complete = 0}) {
  const request = provider === 'workday'
    ? {url: `${config.origin}/wday/cxs/${config.tenant}/${config.site}/jobs`, method: 'POST', body: {limit: 1, offset: 0}}
    : {url: `https://boards-api.greenhouse.io/v1/boards/${config.board_token}/jobs?content=false`, method: 'GET'};
  return {
    waiqi_company_id: id, display_name: name, provider, entry_url: entry, api_config: config, api_request: request,
    reported_jobs: total, source_verification: {complete_jd_samples: complete},
    api_requests: [{index: 0, ...request, purpose: 'public_job_list_capability', checked_at: '2026-09-20T00:00:00Z',
      anonymous_session_from_scratch: true, http_status: 200, content_type: 'application/json', response_is_json: true,
      response_sha256: hash, response_file: file, response_schema_keys: jobs}],
  };
}

test('audit deduplicates with the exact formal sourceKey and keeps true empty APIs pending identity', async () => {
  const config = {origin: 'https://fixture.wd1.myworkdayjobs.com', tenant: 'fixture', site: 'Careers'};
  const first = candidate({id: 1, name: '甲公司', provider: 'workday', entry: config.origin + '/Careers', config, file: 'zero', jobs: ['jobPostings', 'total'], total: 0});
  const second = {...first, waiqi_company_id: 2, display_name: '甲公司别名'};
  const result = await auditDiscoveryCandidates([first, second], {companies: []}, async () => ({jobPostings: [], total: 0}));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].source_key, sourceKey(formalSourceFromDiscovery(first)));
  assert.equal(result.rows[0].capability_state, 'zero_api_pending_identity');
  assert.equal(result.rows[0].zero_job_capability.jobs_observed, 0);
  assert.equal(result.rows[0].identity_review_required, true);
});

test('positive list schema without an explicitly complete JD remains pending', async () => {
  const c = candidate({id: 3, name: 'Example', provider: 'greenhouse', entry: 'https://job-boards.greenhouse.io/example',
    config: {board_token: 'example'}, file: 'positive', jobs: ['jobs', 'jobs[].id', 'meta', 'meta.total'], total: 1});
  const result = await auditDiscoveryCandidates([c], {companies: []}, async () => ({jobs: [{id: 1, company_name: 'Example'}], meta: {total: 1}}));
  assert.equal(result.rows[0].capability_state, 'positive_list_only_pending_full_jd');
  assert.equal(result.rows[0].complete_jd_samples, 0);
  assert.equal(result.rows[0].zero_job_capability, null);
});

test('automatic discovery cannot admit a different API employer such as Andreessen to Carta', async () => {
  const c = candidate({id: 4, name: 'Andreessen Horowitz', provider: 'greenhouse', entry: 'https://job-boards.greenhouse.io/carta/jobs/1',
    config: {board_token: 'carta'}, file: 'carta', jobs: ['jobs', 'jobs[].company_name', 'meta.total'], total: 1, complete: 1});
  c.identity_evidence = {confirmed: true, exact_page_name_matches: ['Andreessen Horowitz']};
  const result = await auditDiscoveryCandidates([c], {companies: []}, async () => ({jobs: [{id: 1, company_name: 'Carta'}], meta: {total: 1}}));
  const row = result.rows[0];
  assert.equal(row.capability_state, 'positive_full_jd_reviewable');
  assert.equal(row.identity_conflict, true);
  assert.match(row.admission_blocked_reason, /different employer/);
  assert.deepEqual(row.returned_identity_names, ['Carta']);
  assert.equal(row.identity_review_status, 'pending');
});

test('registered source keys are marked rather than emitted as expansion', async () => {
  const config = {origin: 'https://fixture.wd1.myworkdayjobs.com', tenant: 'fixture', site: 'Careers'};
  const c = candidate({id: 5, name: 'Fixture', provider: 'workday', entry: config.origin + '/Careers', config, file: 'zero', jobs: ['jobPostings', 'total'], total: 0});
  const existing = {...formalSourceFromDiscovery(c), company_id: 'existing', source_id: 'existing-source'};
  const result = await auditDiscoveryCandidates([c], {companies: [{...existing, recruitment_sources: [existing]}]}, async () => ({jobPostings: [], total: 0}));
  assert.equal(result.rows[0].source_key_already_registered, true);
  assert.equal(result.rows[0].existing_sources[0].company_id, 'existing');
});
