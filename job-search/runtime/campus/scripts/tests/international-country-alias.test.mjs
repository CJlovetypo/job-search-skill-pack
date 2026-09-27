import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {isMainlandChinaCountry, collectInternational} from '../../../../../shared/job-search-core/scripts/lib/providers-international.mjs';
import {collectWorkdayLocationFallback} from '../../../../../shared/job-search-core/scripts/lib/workday-location-fallback.mjs';

test('explicit mainland country aliases accept observed punctuation without admitting HK, Macau or Taiwan', () => {
  for (const value of ['China (Mainland)', 'China/Mainland', ' cn ', 'China', '中国大陆', 'Mainland China']) assert.equal(isMainlandChinaCountry(value), true, value);
  for (const value of ['Hong Kong', 'Hong Kong, China', 'China (Hong Kong)', 'China (Taiwan)', 'Taiwan', 'Macau', 'China/Mainland/Hong Kong', '', null, {descriptor: 'China'}]) assert.equal(isMainlandChinaCountry(value), false, String(value));
});

const source = {provider: 'workday', company_id: 'fixture', display_name: 'Fixture', api_config: {origin: 'https://example.invalid', tenant: 'fixture', site: 'careers'}};
function fixtureClient() {
  const records = [], requests = [], countries = {'one': 'China (Mainland)', 'two': 'China/Mainland', 'hk': 'Hong Kong, China', 'tw': 'Taiwan'};
  return {records, requests, async request(q, meta) {
    requests.push(q);
    const record = {http_status: 200, response_file: '/fixture-' + records.length + '.json', purpose: meta.purpose}; records.push(record);
    let data;
    if (meta.purpose === 'public_country_facet_discovery') data = {facets: [{facetParameter: 'locationCountry', values: [{id: 'cn-mainland', descriptor: 'China (Mainland)'}]}]};
    else if (q.method === 'POST') data = {total: 4, jobPostings: Object.keys(countries).map(id => ({externalPath: '/job/' + id, title: 'Engineer', bulletFields: [id]}))};
    else {
      const id = q.url.split('/').at(-1);
      data = {jobPostingInfo: {jobReqId: id, title: 'Engineer', location: 'Shanghai', country: {descriptor: countries[id]}, canApply: true, externalUrl: 'https://example.invalid/jobs/' + id,
        jobDescription: 'Responsibilities\nDesign and maintain engineering systems, prepare documentation and support project delivery.\nRequirements\nBachelor degree in engineering and at least three years of professional experience.'}};
    }
    return {data, record};
  }};
}

test('country facet and detail routes recognize mainland aliases but still verify every returned country', async () => {
  const client = fixtureClient();
  const result = await collectInternational(source, {client, maxPages: 1});
  assert.deepEqual(client.requests.find(q => q.body?.appliedFacets?.locationCountry)?.body.appliedFacets, {locationCountry: ['cn-mainland']});
  assert.deepEqual(result.jobs.map(j => j.job_id).sort(), ['one', 'two']);
  assert.equal(result.coverage.excluded_country_rows.length, 2);
});

test('location fallback accepts the same mainland country aliases and does not trust Shanghai text alone', async () => {
  const client = fixtureClient();
  const result = await collectWorkdayLocationFallback(source, {client, maxPages: 1, bootstrap: {data: {facets: [{facetParameter: 'locations', values: [{id: 'sh', descriptor: 'Shanghai'}]}]}}});
  assert.deepEqual(result.jobs.map(j => j.job_id).sort(), ['one', 'two']);
  assert.equal(result.coverage.excluded_country_rows.length, 2);
});
