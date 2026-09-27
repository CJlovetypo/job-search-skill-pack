import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {applyWaiqiOwnership, buildWaiqiForeignIndex, extractWaiqiCompanyIds, findRegistryMatches} from '../../../../../shared/job-search-core/scripts/tag-waiqi-ownership.mjs';

const company = (company_id, display_name) => ({company_id, display_name, industry_tags: ['software'], recruitment_sources: []});
const registry = {companies: [company('exact', '精确公司'), company('provenance', '来源公司'), company('context', '上下文公司'), company('tenant', '租户公司'), company('joint', '合资公司')]};
registry.companies[1].recruitment_sources = [{discovery_provenance: {records: [{waiqi_company_id: 2}]}}];
const candidates = {checked_at: '2026-09-20T00:00:00.000Z', companies: [
  {waiqi_company_id: 1, display_name: '精确公司', ownership_hint: '外企', source_url: 'https://waiqi.com/company/detail?id=1', match_evidence: [{company_id: 'exact', basis: ['exact_normalized_name']}]},
  {waiqi_company_id: 2, display_name: '来源公司', ownership_hint: '外企', source_url: 'https://waiqi.com/company/detail?id=2'},
  {waiqi_company_id: 3, display_name: '上下文公司', ownership_hint: '外企', source_url: 'https://waiqi.com/company/detail?id=3'},
  {waiqi_company_id: 4, display_name: '租户公司', ownership_hint: '外企', source_url: 'https://waiqi.com/company/detail?id=4', match_evidence: [{company_id: 'tenant', basis: ['same_recruitment_tenant_requires_entity_review']}]},
  {waiqi_company_id: 5, display_name: '合资公司', ownership_hint: '合资', source_url: 'https://waiqi.com/company/detail?id=5', match_evidence: [{company_id: 'joint', basis: ['exact_normalized_name']}]},
]};
const contexts = [{existing_sources: [{company_id: 'context'}], waiqi_companies: [{waiqi_company_id: 3}]}];
const ownership = {schema_version: 1, companies: registry.companies.map(item => ({company_id: item.company_id, display_name: item.display_name, ownership_tag: item.company_id === 'exact' ? '私企' : '待核实', status: item.company_id === 'exact' ? 'verified' : 'verified_unresolved', reason: '旧结论', checked_at: '2026-01-01', evidence: [{url: 'https://example.com', title: '旧来源', note: '旧依据', checked_at: '2026-01-01'}]}))};
const sizes = {schema_version: 1, companies: registry.companies.map(item => ({company_id: item.company_id, display_name: item.display_name, ownership_tag: '待核实', label: '待核实'}))};
const profiles = {companies: []};

test('index marks only explicit Waiqi 外企 records as verified foreign', () => {
  const index = buildWaiqiForeignIndex(candidates);
  assert.deepEqual(index.counts, {companies: 5, explicit_foreign: 4, joint_venture_not_external_proof: 1});
  assert.equal(index.companies.find(item => item.waiqi_company_id === 5).ownership_tag, null);
  assert.equal(index.companies.find(item => item.waiqi_company_id === 5).status, 'not_external_proof');
});

test('matching accepts exact name, specific reviewed provenance and strict context only', () => {
  const {matches} = findRegistryMatches(registry, candidates, contexts);
  assert.deepEqual([...matches.keys()].sort(), ['context', 'exact', 'provenance']);
  assert.equal(matches.has('tenant'), false);
  assert.equal(matches.has('joint'), false);
  assert.deepEqual([...extractWaiqiCompanyIds({a: [{waiqi_company_id: 2}], waiqi_company_id: 1})].sort(), ['1', '2']);
});

test('tagging preserves unmatched rows, keeps prior classification once and is idempotent', () => {
  const first = applyWaiqiOwnership(registry, ownership, profiles, sizes, candidates, contexts, '2026-09-20T01:00:00.000Z');
  const byId = new Map(first.ownership.companies.map(item => [item.company_id, item]));
  assert.equal(byId.get('exact').ownership_tag, '外企');
  assert.equal(byId.get('exact').prior_classification.ownership_tag, '私企');
  assert.equal(byId.get('tenant').ownership_tag, '待核实');
  assert.equal(byId.get('joint').ownership_tag, '待核实');
  assert.equal(first.sizes.companies.find(item => item.company_id === 'exact').ownership_tag, '外企');
  const second = applyWaiqiOwnership(registry, first.ownership, profiles, first.sizes, candidates, contexts, '2026-09-20T01:00:00.000Z');
  assert.deepEqual(second.ownership, first.ownership);
  assert.deepEqual(second.ownership.companies.find(item => item.company_id === 'exact').prior_classification, byId.get('exact').prior_classification);
});

test('Waiqi never overrides an authoritative supplier classification', () => {
  const supplierOwnership = structuredClone(ownership);
  const target = supplierOwnership.companies.find(item => item.company_id === 'exact');
  target.ownership_tag = '私企';
  target.status = 'verified';
  target.classification_basis = 'supplier_company_nature_classification';
  target.supplier_natures = ['民营企业'];
  const result = applyWaiqiOwnership(registry, supplierOwnership, profiles, sizes, candidates, contexts, '2026-09-20T01:00:00.000Z');
  assert.equal(result.ownership.companies.find(item => item.company_id === 'exact').ownership_tag, '私企');
  assert.equal(result.skippedSupplierAuthority.length, 1);
});

test('Waiqi never turns an officially identified non-enterprise organization back into 外企', () => {
  const officialOwnership = structuredClone(ownership);
  const target = officialOwnership.companies.find(item => item.company_id === 'exact');
  target.ownership_tag = '待核实';
  target.status = 'verified_unresolved';
  target.classification_basis = 'official_identity_outside_enterprise_ownership_taxonomy';
  const result = applyWaiqiOwnership(registry, officialOwnership, profiles, sizes, candidates, contexts, '2026-09-22T01:00:00.000Z');
  assert.equal(result.ownership.companies.find(item => item.company_id === 'exact').ownership_tag, '待核实');
  assert.equal(result.skippedOfficialAuthority.length, 1);
});
