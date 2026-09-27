import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {seedCompanyCityTag} from '../../../../../shared/job-search-core/scripts/lib/waiqi-city-seed.mjs';

const source = {company_id: 'archive-id', source_id: 'source-1', display_name: 'Official', provider: 'moka', primary_entry_url: 'https://app.mokahr.com/social-recruitment/fixture/123', validated_api_request_examples: [{url: 'https://app.mokahr.com/api/outer/ats-apply/website/jobs/v2', purpose: 'job_list', body: {orgId: 'fixture', siteId: 123}}]};
const company = {...source, company_id: 'reviewed-final-id', recruitment_sources: [source]};
const job = (id, city, patch = {}) => ({job_id: id, company_id: 'archive-id', title: '软件工程师', description: '负责业务系统的设计、开发与维护，以及团队协作和项目交付。', requirements: '计算机相关专业本科，掌握开发语言和软件工程实践。', body_complete: true, open_status: 'open', formal_status: 'social', recruitment_evidence: {provider: 'moka', hireMode: 1, commitment: '全职'}, locations_raw: [city], official_url: 'https://app.mokahr.com/social-recruitment/fixture/123#/job/' + id, raw_file: '/official-api-' + id + '.json', ...patch});
const observe = jobs => [{source, result: {jobs, checked_at: '2026-09-20T00:00:00Z', coverage: {status: 'complete', pages: 1}}, file: '/official-result.json'}];

test('only confirmed open jobs seed their own recruitment direction and preserve old cities', () => {
  const jobs = [job('social', '上海'), job('closed', '北京', {open_status: 'closed'}), job('intern', '深圳', {formal_status: 'unknown', title: '软件实习生', recruitment_evidence: {provider: 'moka', commitment: '实习'}})];
  const history = {company_id: company.company_id, cities: ['武汉'], updated_at: '2026-09-01', custom_user_note: 'keep', city_evidence: [{job_id: 'old', cities: ['武汉'], raw_file: '/old.json'}]};
  const social = seedCompanyCityTag(company, observe(jobs), history, 'social', 'result.json');
  assert.deepEqual(social.tag.cities, ['上海', '武汉']);
  assert.equal(social.tag.custom_user_note, 'keep');
  assert(social.tag.city_evidence.some(e => e.job_id === 'old'));
  assert.equal(social.tag.city_coverage_complete, false);
  assert.equal(social.tag.coverage.status, 'partial');
  assert.deepEqual(seedCompanyCityTag(company, observe(jobs), null, 'internship', 'result.json').tag.cities, ['深圳']);
  const campus = seedCompanyCityTag(company, observe(jobs), null, 'campus', 'result.json');
  assert.deepEqual(campus.tag.cities, []);
  assert.equal(campus.tag.city_freshness, 'unknown');
  assert.equal(seedCompanyCityTag(company, observe(jobs), social.tag, 'social', 'result.json').needsUpdate, false);
});

test('reconcileTargetJob downgrades assumed social status without evidence; third-party hints do not seed', () => {
  const unproven = job('assumed', '上海', {recruitment_evidence: {provider: 'workday', timeType: 'Full time'}});
  const thirdParty = job('third-party', '北京', {official_url: 'https://waiqi.com/position/detail?id=3'});
  const noLocation = job('unknown-location', '', {cities: [], city_hint: '深圳'});
  const result = seedCompanyCityTag(company, observe([unproven, thirdParty, noLocation]), null, 'social', 'result.json');
  assert.deepEqual(result.tag.cities, []);
  assert.equal(result.result.jobs.find(j => j.source_job_id === 'assumed').formal_status, 'unknown');
  assert.equal(result.result.jobs.length, 2);
  assert.equal(result.tag.unknown_location_jobs, 1);
});

test('conflicting recruitment types for the same official tenant and job remain unknown', () => {
  const social = job('same', '上海');
  const campus = job('same', '上海', {formal_status: 'formal', recruitment_evidence: {provider: 'moka', hireMode: 2, showIsCampus: true}});
  const result = seedCompanyCityTag(company, [...observe([social]), ...observe([campus])], null, 'social', 'result.json');
  assert.deepEqual(result.tag.cities, []);
  assert.equal(result.result.jobs[0].formal_status, 'unknown');
});
