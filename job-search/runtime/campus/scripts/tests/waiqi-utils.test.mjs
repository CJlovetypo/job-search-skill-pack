import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {requestSlot, retryAfterMs, csvCell, recruitmentLink} from '../../../../../shared/job-search-core/scripts/lib/waiqi-utils.mjs';

test('requests waking from shared cooldown still acquire spaced slots', () => {
  let next = 1000;
  assert.equal(requestSlot(1000, next, 60000, 750).waitMs, 59000);
  const first = requestSlot(60000, next, 60000, 750);
  assert.equal(first.waitMs, 0);
  next = first.nextRequest;
  assert.equal(requestSlot(60000, next, 60000, 750).waitMs, 750);
  assert.equal(requestSlot(60750, next, 120000, 750).waitMs, 59250);
});

test('server Retry-After supports seconds and HTTP dates without negative delays', () => {
  const now = Date.parse('2026-09-20T00:00:00Z');
  assert.equal(retryAfterMs('120', now), 120000);
  assert.equal(retryAfterMs('Sun, 20 Sep 2026 00:02:00 GMT', now), 120000);
  assert.equal(retryAfterMs('Sat, 19 Sep 2026 23:59:00 GMT', now), 0);
  assert.equal(retryAfterMs('bad', now), 0);
});

test('CSV preserves quoted multiline cells and neutralizes whitespace-prefixed formulas', () => {
  assert.equal(csvCell('hello,"world"\nnext'), '"hello,""world""\nnext"');
  for (const value of ['=1+1', '+cmd', '-cmd', '@sum(1)', '  =1+1', '\t=1+1', '\r=1+1']) assert.equal(csvCell(value), '"\'' + value + '"');
  assert.equal(csvCell('公司 A'), '"公司 A"');
  assert.equal(csvCell(null), '""');
});

test('prefixed recruitment URLs retain query and fragment while non-URL instructions remain explicit',()=>{
 const url='https://app.mokahr.com/apply/acme/123?channel=test#/job/abc';
 const raw='链接请在微信端打开:'+url;
 assert.deepEqual(recruitmentLink(raw),{url,raw,normalization:'extracted_explicit_url'});
 assert.equal(recruitmentLink(url).normalization,'unchanged');
 assert.equal(recruitmentLink('公益直推邮箱链接：hr@example.com').url,null);
 assert.equal(recruitmentLink('sidel.com/careers/job').normalization,'assumed_https_for_bare_domain');
 assert.equal(recruitmentLink('javascript:alert(1)').url,null);
 assert.equal(recruitmentLink('https://user:password@example.com/jobs').url,null);
});
