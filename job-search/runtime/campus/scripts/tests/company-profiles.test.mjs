import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {SKILL_ROOT, writeJson} from '../lib/io.mjs';
await fs.mkdir(path.join(SKILL_ROOT,'tmp'),{recursive:true});
import {mergeProfiles, companyProfileSnapshot, saveCompanyProfileSnapshot, companyProfileSheet, emptyFact, factProblem} from '../lib/company-profiles.mjs';

const fact = value => ({value, status: 'verified', entity: '测试集团全球员工', as_of: '2025-12-31', checked_at: '2026-09-13', evidence: [{url: 'https://example.com/report', title: '合成年报', note: '合成测试数据'}]});
test('资料按ID增量维护，业务初始化不覆盖人数或历史资本，不猜同名主体', () => {
  const sources = [{company_id: 'a', display_name: '同名公司'}, {company_id: 'b', display_name: '同名公司'}];
  const previous = {companies: [{company_id: 'a', workforce: fact('100人'), capital: fact('2020年融资')}]};
  const merged = mergeProfiles(sources, {companies: []}, previous, [{company_id: 'a', business: fact('软件业务')}]);
  assert.equal(merged.companies[0].workforce.value, '100人');
  assert.equal(merged.companies[0].capital.value, '2020年融资');
  assert.equal(merged.companies[1].workforce.status, 'missing');
  assert.throws(() => mergeProfiles(sources, {companies: []}, previous, [{company_id: 'absent'}]), /未知/);
  assert.throws(() => mergeProfiles(sources, {companies: []}, previous, [{company_id: 'a'}, {company_id: 'a'}]), /重复/);
  assert.ok(factProblem({...fact('100人'), evidence: []}));
  assert.ok(factProblem({...emptyFact(), value: '估计100人'}));
  assert.ok(factProblem({...fact('100人'), evidence: [{url: 'file:///secret', title: 'x', note: 'x'}]}));
});

test('运行快照离线复用且公司去重，只有覆盖表中的公司和缺资料公司也保留三行', async () => {
  const dir = await fs.mkdtemp(path.join(SKILL_ROOT, 'tmp/profile-snapshot-test-'));
  const companies = [{company_id: 'synthetic', display_name: '已评估测试公司'}, {company_id: 'excluded-test', display_name: '城市排除公司'}, {company_id: 'unattempted-test', display_name: '未采集公司'}];
  const saved = {schema_version: 1, captured_at: '2026-09-01', source_updated_at: '2026-08-01', companies: [{...companies[0], business: fact('测试业务'), workforce: fact('历史100人'), capital: emptyFact()}]};
  await saveCompanyProfileSnapshot(dir, saved);
  const snapshot = await companyProfileSnapshot(dir, [...companies, companies[0]]);
  assert.equal(snapshot.captured_at, saved.captured_at);
  assert.equal(snapshot.companies.length, 3);
  assert.equal(snapshot.companies[0].workforce.value, '历史100人');
  const sheet = companyProfileSheet(snapshot);
  assert.equal(sheet.rows.length, 9);
  assert.deepEqual([...new Set(sheet.rows.map(r => r[0]))], companies.map(c => c.display_name));
  assert.equal(sheet.rows[1][4], '2025-12-31');
  assert.equal(sheet.rows[2][2], '暂无已核实资料');
  assert.ok(sheet.rows.slice(3).every(r => r[2] === '暂无已核实资料'));
  assert.equal(companyProfileSheet({companies: []}).rows.length, 0);
  await writeJson(path.join(dir, 'company-profiles.snapshot.json'), {...saved, companies: [...saved.companies, ...saved.companies]});
  await assert.rejects(() => companyProfileSnapshot(dir, companies), /重复/);
});
test('扩容的部分调研线索不冒充核实事实，也不阻断岗位评估',async()=>{
 const dir=await fs.mkdtemp(path.join(SKILL_ROOT,'tmp/profile-clue-test-'));
 const company={company_id:'clue',display_name:'线索公司'},clue={...fact('汇总表上的行业线索'),status:'partial'};
 await saveCompanyProfileSnapshot(dir,{companies:[{...company,business:clue}]});
 const snapshot=await companyProfileSnapshot(dir,[company]);
 assert.equal(snapshot.companies[0].business.status,'missing');
 assert.deepEqual(snapshot.companies[0].business.unverified_source_fact,clue);
 assert.equal(companyProfileSheet(snapshot).rows[0][2],'暂无已核实资料');
 assert.ok(factProblem(clue));
});
