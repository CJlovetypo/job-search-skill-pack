import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appendMissingTags, appendMissingProfileTags} from '../../../../../shared/job-search-core/scripts/seed-missing-company-tags.mjs';

test('missing metadata appends unknowns without inferring aggregator hints or changing existing edits', () => {
  const registry = {companies:[{company_id:'old',display_name:'Old'}, {company_id:'new',display_name:'New',ownership_hint:'外企',size_hint:'10000人'}]};
  const ownership = {companies:[{company_id:'old',display_name:'User name',status:'verified',ownership_tag:'国企',custom:{note:'uncommitted'}}]};
  const size = {model:{version:'existing'},companies:[{company_id:'old',label:'用户标签',evidence:[{url:'saved'}]}]};
  const original = structuredClone({registry, ownership, size});
  const next = appendMissingTags(registry, ownership, size, '2026-09-20T00:00:00Z');
  assert.deepEqual({registry, ownership, size}, original);
  assert.deepEqual(next.ownership.companies[0], ownership.companies[0]);
  assert.deepEqual(next.size.companies[0], size.companies[0]);
  assert.equal(next.ownershipAdded[0].checked_at, null);
  assert.equal(next.ownershipAdded[0].ownership_tag, '待核实');
  assert.equal(next.sizeAdded[0].status, 'unknown');
  assert.equal(next.sizeAdded[0].workforce, '');
  assert.deepEqual(next.sizeAdded[0].evidence, []);
  const repeat = appendMissingTags(registry, next.ownership, next.size, '2026-09-21T00:00:00Z');
  assert.deepEqual(repeat.ownership, next.ownership);
  assert.deepEqual(repeat.size, next.size);
  assert.equal(repeat.sizeAdded.length + repeat.ownershipAdded.length, 0);
});

test('duplicate registry or metadata IDs are rejected rather than silently merged', () => {
  const duplicate = {companies:[{company_id:'x'}, {company_id:'x'}]}, empty = {companies:[]};
  assert.throws(() => appendMissingTags(duplicate, empty, empty), /duplicate IDs/);
  assert.throws(() => appendMissingTags(empty, duplicate, empty), /duplicate IDs/);
});

test('business and profile placeholders preserve manual facts and remain idempotent', () => {
  const registry = {companies:[{company_id:'old'}, {company_id:'new',display_name:'New',industry_hint:'医药'}]};
  const document = {companies:[{company_id:'old',manual_note:'keep',workforce:{value:'verified fact'}}]};
  for (const kind of ['business', 'profiles']) {
    const {next, added} = appendMissingProfileTags(registry, document, kind, 'now');
    assert.deepEqual(next.companies[0], document.companies[0]);
    assert.equal(added.length, 1);
    if (kind === 'business') assert.deepEqual(added[0].business_tags, []);
    else assert.deepEqual(added[0].workforce, {value:'',status:'missing',entity:'',as_of:'',checked_at:'',evidence:[]});
    assert.deepEqual(appendMissingProfileTags(registry, next, kind, 'later').next, next);
  }
});
