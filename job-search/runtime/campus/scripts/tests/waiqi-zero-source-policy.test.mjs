import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {planWaiqiIntegration} from '../../../../../shared/job-search-core/scripts/lib/waiqi-integration.mjs';
import {prepareZeroJobCandidate, zeroJobCapability} from '../../../../../shared/job-search-core/scripts/lib/waiqi-zero-source-policy.mjs';

const hash = 'a'.repeat(64);
const source = {
  company_id: 'waiqi-zero-fixture',
  display_name: '聚合站线索名称',
  provider: 'moka',
  primary_entry_url: 'https://fixture.invalid/campus-recruitment/official-org/1',
  validated_api_request_examples: [{
    url: 'https://fixture.invalid/api/outer/ats-apply/website/jobs/v2',
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: {orgId: 'official-org', siteId: '1'},
    purpose: 'job_list',
  }],
};
const result = {
  checked_at: '2026-09-20T01:02:03Z',
  jobs: [],
  requests: [{
    index: 0,
    purpose: 'job_list',
    method: 'POST',
    url: source.validated_api_request_examples[0].url,
    headers: {'Content-Type': 'application/json'},
    http_status: 200,
    content_type: 'application/json',
    response_is_json: true,
    response_sha256: hash,
    response_file: '/proof/list.json',
    response_schema_keys: ['code', 'data', 'data.jobs', 'data.jobStats', 'data.jobStats.total'],
    anonymous_session_from_scratch: true,
  }],
  coverage: {
    status: 'complete', jobs_observed: 0, pages: 1, list_complete: true,
    contexts: [{status: 'complete', jobs_observed: 0, pages: 1, list_complete: true}],
    page_evidence: [{request_index: 0, job_ids: [], server_total: 0}],
  },
};
const review = {
  identity_verified: true,
  official_name: '官方公司名称',
  evidence_file: '/proof/identity.json',
  basis: 'Official portal title and public API organization fields identify the same employer.',
  industry_tags: ['internet'],
};

test('actual anonymous empty JSON list can be packaged and integrated without pretending to have a JD', () => {
  const candidate = prepareZeroJobCandidate({source, result, review, proofDirectory: '/proof'});
  assert.equal(candidate.verification_status, 'verified_api_zero_jobs');
  assert.equal(candidate.source_verification.complete_jd_samples, 0);
  const planned = planWaiqiIntegration({companies: []}, [{item: candidate, file: '/proof/admitted.json'}], ['internet']);
  assert.equal(planned.rejected.length, 0);
  assert.equal(planned.added.length, 1);
  assert.equal(planned.registry.companies[0].verification_status, 'verified_api_zero_jobs');
});

test('zero-job capability requires a real reconciled list API request, never an aggregate company count', () => {
  assert.match(zeroJobCapability(source, {...result, requests: []}).problem, /request evidence/);
  assert.match(zeroJobCapability(source, {...result, coverage: {...result.coverage, status: 'partial'}}).problem, /not complete/);
  assert.match(zeroJobCapability(source, {...result, jobs: [{job_id: '1'}]}).problem, /not an empty/);
  const aggregate = {...result, requests: [{...result.requests[0], purpose: 'company_info'}]};
  assert.match(zeroJobCapability(source, aggregate).problem, /request evidence/);
  const claimedZero = {...result, coverage: {...result.coverage, page_evidence: [{request_index: 0, job_ids: [], server_total: 3}]}};
  assert.match(zeroJobCapability(source, claimedZero).problem, /actual zero-job/);
});

test('HTML, credentials and an unrecognized list schema cannot become zero-job API evidence', () => {
  const html = {...result, requests: [{...result.requests[0], response_is_json: false, content_type: 'text/html'}]};
  assert.match(zeroJobCapability(source, html).problem, /not JSON/);
  const auth = {...result, requests: [{...result.requests[0], headers: {Authorization: 'Bearer imported'}}]};
  assert.match(zeroJobCapability(source, auth).problem, /credentials/);
  const wrongShape = {...result, requests: [{...result.requests[0], response_schema_keys: ['company.positionCount']}]};
  assert.match(zeroJobCapability(source, wrongShape).problem, /job-list path/);
});

test('official identity review is mandatory and the historical full-JD policy remains strict', () => {
  assert.throws(() => prepareZeroJobCandidate({source, result, review: {...review, identity_verified: false}, proofDirectory: '/proof'}), /identity/);
  const zero = prepareZeroJobCandidate({source, result, review, proofDirectory: '/proof'});
  const missingIdentity = {...zero, identity_verification: {...zero.identity_verification, evidence_file: ''}};
  assert.equal(planWaiqiIntegration({companies: []}, [{item: missingIdentity, file: '/proof'}], ['internet']).added.length, 0);
  const disguisedLegacy = {...zero, verification_status: 'verified_api_full_jd'};
  assert.equal(planWaiqiIntegration({companies: []}, [{item: disguisedLegacy, file: '/proof'}], ['internet']).added.length, 0);
});
