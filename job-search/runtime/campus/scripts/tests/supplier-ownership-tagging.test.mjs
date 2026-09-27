import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {applySupplierOwnership, extractSupplierNatures, resolveSupplierNatures} from '../../../../../shared/job-search-core/scripts/tag-supplier-ownership.mjs';

const evidence = nature => [{url: 'https://example.com/jobs', title: '招聘来源', note: `源记录 natures=${JSON.stringify(nature)}`, checked_at: '2026-01-01'}];

test('supplier natures are recovered from active, prior and reason-only records', () => {
  const row = {reason: '旧库供应商性质提示为“民营企业、央国企”', evidence: evidence(['外企']), prior_classification: {evidence: evidence(['中外合资/港澳台资'])}};
  assert.deepEqual(extractSupplierNatures(row), ['外企', '民营企业', '央国企', '中外合资/港澳台资']);
});

test('supplier mapping resolves private, foreign and state while retaining true conflicts', () => {
  assert.deepEqual(resolveSupplierNatures(['民营企业']), {action: 'classified', ownership_tag: '私企', mapped_tags: ['私企']});
  assert.equal(resolveSupplierNatures(['外企', '中外合资/港澳台资']).action, 'conflict');
  assert.deepEqual(resolveSupplierNatures(['央国企']), {action: 'classified', ownership_tag: '国企', mapped_tags: ['国企']});
  assert.equal(resolveSupplierNatures(['民营企业', '外企']).action, 'conflict');
  assert.equal(resolveSupplierNatures(['事业单位']).action, 'unmapped');
});

test('full refresh overrides Waiqi, preserves history, updates size and is idempotent', () => {
  const registry = {companies: [{company_id: 'x', display_name: 'X'}, {company_id: 'y', display_name: 'Y'}]};
  const ownership = {companies: [
    {company_id: 'x', display_name: 'X', ownership_tag: '外企', status: 'verified', reason: 'Waiqi', checked_at: '2026-09-20', evidence: [{url: 'https://waiqi.com/company/detail?id=1', title: 'Waiqi', note: '外企'}], classification_basis: 'waiqi_explicit_foreign_company_type', prior_classification: {company_id: 'x', display_name: 'X', ownership_tag: '待核实', status: 'verified_unresolved', reason: '旧库供应商性质提示为“民营企业”', checked_at: '2026-01-01', evidence: evidence(['民营企业'])}},
    {company_id: 'y', display_name: 'Y', ownership_tag: '待核实', status: 'verified_unresolved', reason: '旧库供应商性质提示为“民营企业、外企”', checked_at: '2026-01-01', evidence: evidence(['民营企业', '外企'])},
  ]};
  const sizes = {companies: registry.companies.map(item => ({company_id: item.company_id, display_name: item.display_name, ownership_tag: '待核实', label: '待核实'}))};
  const first = applySupplierOwnership(registry, ownership, {companies: []}, sizes, '2026-09-20T03:00:00.000Z');
  assert.equal(first.ownership.companies[0].ownership_tag, '私企');
  assert.equal(first.ownership.companies[0].classification_history[0].ownership_tag, '外企');
  assert.equal(first.ownership.companies[1].ownership_tag, '待核实');
  assert.equal(first.ownership.companies[1].status, 'verified_unresolved');
  assert.equal(first.sizes.companies[0].ownership_tag, '私企');
  const second = applySupplierOwnership(registry, first.ownership, {companies: []}, first.sizes, '2026-09-20T03:00:00.000Z');
  assert.deepEqual(second.ownership, first.ownership);
});
