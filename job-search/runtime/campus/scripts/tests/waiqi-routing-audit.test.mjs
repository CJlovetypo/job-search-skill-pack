import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {auditWaiqiRouting, sourceContextKey} from '../../../../../shared/job-search-core/scripts/audit-waiqi-routing.mjs';

test('routing audit separates exact ATS capability, host-only leads and missing links', () => {
  const workday = {
    provider: 'workday',
    primary_entry_url: 'https://acme.wd3.myworkdayjobs.com/External',
    api_config: {origin: 'https://acme.wd3.myworkdayjobs.com', tenant: 'acme', site: 'External'},
  };
  const custom = {provider: 'custom_public', primary_entry_url: 'https://jobs.example.com/search'};
  const report = auditWaiqiRouting({
    checked_at: '2026-09-20T00:00:00.000Z',
    companies: [{
      waiqi_company_id: 1,
      display_name: 'Acme',
      returned_position_count: 5,
      match_evidence: [{company_id: 'acme', basis: ['exact_normalized_name']}],
      recruitment_links: [
        {url: 'https://acme.wd3.myworkdayjobs.com/External/job/City/Role_R1', job_ids: ['1', '2']},
        {url: 'https://jobs.smartrecruiters.com/Other/123-role', job_ids: ['3']},
        {url: 'https://jobs.example.com/job/4', job_ids: ['4']},
      ],
    }],
  }, {companies: [
    {company_id: 'acme', display_name: 'Acme', recruitment_sources: [workday]},
    {company_id: 'custom', display_name: 'Custom', recruitment_sources: [custom]},
  ]});
  assert.equal(sourceContextKey(workday), 'workday|https://acme.wd3.myworkdayjobs.com|acme|external');
  assert.deepEqual(report.summary, {
    catalog_companies: 1,
    active_companies: 1,
    waiqi_displayed_jobs: 5,
    jobs_with_external_url: 4,
    jobs_without_external_url: 1,
    skill_parseable_url_jobs: 3,
    registered_exact_context_jobs: 2,
    registered_host_jobs: 3,
    active_companies_with_any_registered_context: 1,
    active_companies_fully_context_covered: 0,
  });
  assert.equal(report.by_provider.workday.registered_context_jobs, 2);
  assert.equal(report.by_provider.smartrecruiters.registered_context_jobs, 0);
  assert.equal(report.by_provider.unsupported.registered_host_jobs, 1);
  assert.deepEqual(report.unregistered_parseable_contexts.map(item => ({
    context_key: item.context_key,
    provider: item.provider,
    jobs: item.jobs,
    companies: item.companies,
  })), [{
    context_key: 'smartrecruiters|other',
    provider: 'smartrecruiters',
    jobs: 1,
    companies: 1,
  }]);
  assert.deepEqual(report.match_basis.exact_normalized_name, {companies: 1, jobs: 5});
});
