import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {planWaiqiIntegration, sourceKey} from '../../../../../shared/job-search-core/scripts/lib/waiqi-integration.mjs';

const candidate = (token, patch = {}) => ({company_id: 'new-' + token, display_name: 'Reviewed ' + token, provider: 'greenhouse', api_config: {board_token: token}, primary_entry_url: 'https://job-boards.greenhouse.io/' + token, industry_tags: ['internet'], api_verified_at: '2026-09-20T00:00:00Z', api_verification: {complete_mainland_jds: 1, evidence_file: '/proof/verification.json'}, identity_verification: {evidence_file: '/proof/identity.json'}, validated_api_request_examples: [{url: 'https://boards-api.greenhouse.io/v1/boards/' + token + '/jobs?content=true', purpose: 'job_list_with_full_content'}], ...patch});
const input = item => ({item, file: '/admitted.json'});
const original = {custom_metadata: 'keep', companies: [{...candidate('old'), company_id: 'user-existing', display_name: '用户公司名', aliases: ['用户别名'], notes: {user: true}}]};
const plan = (registry, items) => planWaiqiIntegration(registry, items.map(input), ['internet']);

test('reviewed group names label new parents while source brands and existing names survive', () => {
  const a = candidate('a', {merge_group_key: 'g', suggested_group_display_name: 'Parent Group'});
  const b = candidate('b', {merge_group_key: 'g', suggested_group_display_name: 'Parent Group'});
  const result = plan({companies: []}, [a, b]);
  assert.equal(result.registry.companies[0].display_name, 'Parent Group');
  assert.deepEqual(result.registry.companies[0].recruitment_sources.map(s => s.display_name), ['Reviewed a', 'Reviewed b']);
  assert.equal(plan(original, [{...a, suggested_existing_company_id: 'user-existing'}]).registry.companies[0].display_name, '用户公司名');
  assert.equal(plan({companies: []}, [a, {...b, suggested_group_display_name: 'Other Group'}]).rejected.length, 2);
});

test('group resolution uses a later existing-source anchor and preserves user IDs and metadata', () => {
  const fresh = candidate('fresh', {merge_group_key: 'reviewed-group'});
  const anchor = candidate('old', {merge_group_key: 'reviewed-group'});
  const before = structuredClone(original);
  for (const order of [[fresh, anchor], [anchor, fresh]]) {
    const result = plan(original, order);
    assert.equal(result.registry.companies.length, 1);
    const company = result.registry.companies[0];
    assert.equal(company.company_id, 'user-existing');
    assert.equal(company.display_name, '用户公司名');
    assert.deepEqual(company.aliases, ['用户别名']);
    assert.deepEqual(company.notes, {user: true});
    assert.equal(company.recruitment_sources.length, 2);
    assert.deepEqual(company.recruitment_sources[0], {...before.companies[0], source_id: '0'});
    const again = plan(result.registry, order);
    assert.equal(again.added.length, 0);
    assert.deepEqual(again.registry, result.registry);
  }
  assert.deepEqual(original, before);
});

test('a rejected input cannot redirect a verified group to an existing company', () => {
  const poison = candidate('bad', {merge_group_key: 'g', suggested_existing_company_id: 'user-existing', api_verification: {complete_mainland_jds: -1, evidence_file: '/proof'}});
  const good = candidate('new', {merge_group_key: 'g'});
  const result = plan(original, [poison, good]);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.added[0].company_id, 'new-new');
  assert.deepEqual(result.registry.companies[0], original.companies[0]);
});

test('conflicting group anchors reject the whole group without a partial append', () => {
  const registry = {...original, companies: [...original.companies, {...candidate('other'), company_id: 'existing-other'}]};
  const result = plan(registry, [candidate('fresh', {merge_group_key: 'g'}), candidate('old', {merge_group_key: 'g'}), candidate('other', {merge_group_key: 'g'})]);
  assert.equal(result.added.length, 0);
  assert.equal(result.rejected.length, 3);
  assert.deepEqual(result.registry, registry);
});

test('partial configurations, false verification and accidental ID collisions are not admitted', () => {
  for (const patch of [{api_config: {}}, {verification_status: 'unverified'}, {admitted: false}, {api_verified_at: null}, {company_id: 'user-existing'}]) {
    const result = plan(original, [candidate('fresh', patch)]);
    assert.equal(result.added.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.deepEqual(result.registry, original);
  }
  assert.notEqual(sourceKey({provider: 'workday', api_config: {origin: 'https://example.test', tenant: 'x', site: 'Careers'}}), sourceKey({provider: 'workday', api_config: {origin: 'https://example.test', tenant: 'x', site: 'careers'}}));
});

test('legacy full-JD candidates keep their original verification status', () => {
  const result = plan({companies: []}, [candidate('still-full-jd')]);
  assert.equal(result.registry.companies[0].verification_status, 'verified_api_full_jd');
  assert.equal(result.registry.companies[0].recruitment_sources[0].verification_status, 'verified_api_full_jd');
});

test('source keys collapse job-detail URLs to their public recruitment tenant', () => {
  const oracle = site => ({provider: 'oracle_recruiting', api_config: {origin: 'https://EXAMPLE.oraclecloud.com', site}, primary_entry_url: 'https://example.oraclecloud.com/job/1'});
  assert.equal(sourceKey(oracle('CX_1')), sourceKey(oracle('cx_1')));
  assert.equal(sourceKey({provider: 'hotjob', primary_entry_url: 'https://jobs.example/SUabc123/pb/posDetail.html?postId=one'}), sourceKey({provider: 'hotjob', primary_entry_url: 'https://jobs.example/SUabc123/pb/posDetail.html?postId=two'}));
  assert.equal(sourceKey({provider: 'moka', primary_entry_url: 'https://jobs.example/social-recruitment/acme/42#/job/one'}), sourceKey({provider: 'moka', primary_entry_url: 'https://jobs.example/social-recruitment/acme/42#/job/two'}));
});

const reviewed=(token,id=42,name='Reviewed employer')=>candidate(token,{
  display_name:name,merge_group_key:'interface-'+token,
  discovery_provenance:{dataset:'waiqi-company-interface-deep-review',waiqi_company_id:id},
  identity_verification:{identity_verified:true,official_name:name,evidence_file:'/proof/employer.json',basis:'Reviewed official recruitment employer'},
});

test('reviewed employer identity groups distinct interfaces and keeps every source contract',()=>{
  const first=reviewed('site-one'),second=reviewed('site-two');
  const result=plan({companies:[]},[first,second]);
  assert.equal(result.registry.companies.length,1);
  assert.equal(result.registry.companies[0].recruitment_sources.length,2);
  assert.equal(result.added.filter(r=>r.new_company).length,1);
  const again=plan(result.registry,[first,second,reviewed('site-three')]);
  assert.equal(again.registry.companies.length,1);
  assert.equal(again.registry.companies[0].recruitment_sources.length,3);
  assert.equal(again.registry.companies[0].company_id,first.company_id);
});

test('supplier IDs and matching labels cannot merge different or unreviewed employers',()=>{
  const a=reviewed('one'),differentName=reviewed('two',42,'Another employer'),differentId=reviewed('three',99);
  const unreviewed=reviewed('four');delete unreviewed.identity_verification.identity_verified;
  assert.equal(plan({companies:[]},[a,differentName,differentId,unreviewed]).registry.companies.length,4);
  const b=reviewed('other');
  const conflict=plan({companies:[a,b]},[reviewed('fresh')]);
  assert.equal(conflict.added.length,0);assert.match(conflict.rejected[0].reason,/conflicting existing IDs/);
});
