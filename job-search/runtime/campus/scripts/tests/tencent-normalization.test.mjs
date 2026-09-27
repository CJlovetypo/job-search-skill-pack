import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCustomJob} from '../lib/providers-custom.mjs';

const source = {company_id: 'tencent-test', display_name: '腾讯', primary_entry_url: 'https://join.qq.com/'};
const raw = overrides => ({postId: '1282707398326592512', title: '测试岗位', workCityList: ['深圳'], recruitType: 1, recruitLabelName: '应届毕业生', projectId: 1, ...overrides});

test('腾讯正文保留职责、任职要求与加分项边界，不将加分经验混作基础要求', () => {
  const input = raw({
    desc: '<p>负责计算平台开发与协作。</p>',
    request: '<p>掌握 Python，能够完成需求分析。</p>',
    graduateBonus: '<p>熟悉主流训练流程及 Transformer 者优先。</p><p>有开源项目经验加分。</p>',
  });
  const before = structuredClone(input);
  const job = normalizeCustomJob('tencent', input, source, {rawFile: 'saved-detail.json'});
  assert.equal(job.description, '岗位职责\n负责计算平台开发与协作。');
  assert.equal(job.requirements.split('\n\n')[0], '任职要求\n掌握 Python，能够完成需求分析。');
  assert.match(job.requirements, /加分项[^\n]*\n熟悉主流训练流程及 Transformer 者优先。\n有开源项目经验加分。$/);
  assert.equal(job.body_complete, true);
  assert.deepEqual(job.raw_metadata.body_fields, {desc: input.desc, request: input.request, graduateBonus: input.graduateBonus});
  assert.equal(job.raw_file, 'saved-detail.json');
  assert.deepEqual(input, before, '归一化不得改写已保存的来源字段');
});

test('腾讯加分项中的硬性提交要求完整保留，不能因字段名降格为可选', () => {
  const instruction = '申请者必须上传 PDF 格式的投资分析报告，未提交不予考虑。';
  const job = normalizeCustomJob('tencent', raw({
    desc: '开展行业研究并输出投资分析。',
    request: '具备研究分析与书面表达能力。',
    graduateBonus: '<p>有行业研究经历者优先。</p><p>' + instruction + '</p>',
  }), source);
  assert.ok(job.requirements.includes(instruction), '必须保留原文中的必须与未提交后果');
  assert.match(job.requirements, /加分项（仍以条文措辞判断硬性要求）/);
  assert.match(job.requirements, /有行业研究经历者优先。/);
  assert.equal(job.raw_metadata.body_fields.graduateBonus, '<p>有行业研究经历者优先。</p><p>' + instruction + '</p>');
});

test('腾讯缺少核心正文时标签与加分项不能使 body_complete 变真', () => {
  for (const fields of [
    {},
    {desc: '<p>&nbsp;</p>', request: '<br>', graduateBonus: '<p></p>'},
    {graduateBonus: '必须上传 PDF 报告。'},
    {desc: '岗位职责已有正文。', graduateBonus: '熟悉训练流程者优先。'},
    {request: '任职要求已有正文。', graduateBonus: '有开源经验者优先。'},
  ]) {
    const job = normalizeCustomJob('tencent', raw(fields), source);
    assert.equal(job.body_complete, false, JSON.stringify(fields));
    if (!fields.desc || fields.desc === '<p>&nbsp;</p>') assert.equal(job.description, '');
    if (!fields.request) assert.doesNotMatch(job.requirements, /^任职要求\n/);
  }
  const complete = normalizeCustomJob('tencent', raw({desc: '负责项目交付。', request: '本科及以上学历。'}), source);
  assert.equal(complete.body_complete, true);
  assert.doesNotMatch(complete.requirements, /加分项/);
});

test('腾讯分段只清理一次 HTML，实体表示的原文不会被误删', () => {
  const job = normalizeCustomJob('tencent', raw({desc: '<p>维护 &lt;Service&gt; 服务。</p>', request: '<p>理解 &lt;Model&gt; 接口。</p>', graduateBonus: '<p>熟悉 &lt;Transformer&gt; 模型者优先。</p>'}), source);
  assert.match(job.description, /维护 <Service> 服务。/);
  assert.match(job.requirements, /理解 <Model> 接口。/);
  assert.match(job.requirements, /熟悉 <Transformer> 模型者优先。/);
});

test('腾讯分段修复不改变其他 provider 的正文或额外添加腾讯字段', () => {
  const job = normalizeCustomJob('alibaba', {id: 'other-job', name: '测试岗位', workLocations: ['杭州'], description: '负责开发。', requirement: '掌握 Java。', categoryType: 'freshman', status: 'recruit'}, {company_id: 'alibaba-test', display_name: '阿里巴巴', primary_entry_url: 'https://campus-talent.alibaba.com/'});
  assert.equal(job.description, '负责开发。');
  assert.equal(job.requirements, '掌握 Java。');
  assert.equal(job.body_complete, true);
  assert.equal(job.raw_metadata, undefined);
});
