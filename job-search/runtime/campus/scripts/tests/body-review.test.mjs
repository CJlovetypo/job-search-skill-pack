import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewJobBody, extractRawBody, bodyText } from '../lib/body-review.mjs';

test('co-located body keeps all text, including optional conditions', () => {
  const description = '岗位内容：\n负责产品需求分析和版本交付。\n任职要求：\n本科以上，具备沟通能力。\n加分项：\n有项目管理实习经历优先。\n其他信息：\n轮班工作。';
  const input = { job_id: '1', description, requirements: '', body_complete: false, formal_status: 'unknown' };
  const out = reviewJobBody(input);
  assert.equal(out.body_complete, true);
  assert.equal(out.description, description);
  assert.match(out.requirements, /加分项：\n有项目管理实习经历优先/);
  assert.equal(out.formal_status, 'unknown');
  assert.equal(input.requirements, '');
});
test('headerless numbered lists require both duties and multiple conditions', () => {
  assert.equal(reviewJobBody({ description: '1、参与前端功能开发。\n2、负责测试与上线。\n1、熟悉JavaScript和CSS。\n2、具备沟通能力，有相关项目经验优先。' }).body_complete, true);
  assert.equal(reviewJobBody({ description: '1、负责测试与上线。\n2、参与项目会议。' }).body_complete, false);
  assert.equal(reviewJobBody({ description: '任职要求：\n本科及以上学历。\n具备良好的沟通能力。' }).body_complete, false);
});
test('English and aliases work; empty headings and placeholders do not', () => {
  assert.equal(reviewJobBody({ description: 'What you will do:\nBuild reliable services.\nMinimum qualifications:\nExperience with Java.\nPreferred qualifications:\nKnowledge of SQL.' }).body_complete, true);
  const kpmgStyle = reviewJobBody({ description: 'Key Responsibilities\nAudit financial statements and coordinate delivery with the engagement team.\nExperience & Background\nBachelor degree in accounting or finance, with analytical and communication skills.' });
  assert.equal(kpmgStyle.body_complete, true);
  assert.match(kpmgStyle.requirements, /Experience & Background/);
  for (const description of ['TEST', '公司拥有优秀团队和丰富福利，欢迎加入我们。', '岗位职责：\n任职要求：']) assert.equal(reviewJobBody({ description, requirements: '·' }).body_complete, false);
});
test('raw extraction selects exact job, supports topic fields and bonus distinctions', () => {
  const raw = extractRawBody({ data: { postId: 'x', desc: '', request: '', topicDetail: '负责大模型训练与研究。', topicRequirement: '硕士以上，精通PyTorch。', graduateBonus: '有顶会论文优先。' } }, 'x');
  assert.match(raw.description, /负责大模型/);
  assert.match(raw.requirements, /补充说明（原字段 graduateBonus）/);
  assert.equal(extractRawBody({ data: { postId: 'y', topicDetail: '负责训练' } }, 'x').error, 'no_exact_id_record');
});
test('bonus alone and falsely labelled qualification-only duties do not prove complete', () => {
  assert.equal(reviewJobBody({ description: '负责教学授课和教研备课。', requirements: 'Preferred qualifications:\nExperience with teaching.' }).body_complete, false);
  assert.equal(reviewJobBody({ description: '岗位职责：\n本科及以上学历。\n熟悉Java语言。\n熟练使用Linux操作系统。' }).body_complete, false);
});
test('HTML preserves line breaks, comparisons and entities', () => {
  assert.equal(bodyText('<p>熟悉 C++ &amp; Python，N &lt; 5。</p><p>硕士以上。</p>'), '熟悉 C++ & Python，N < 5。\n硕士以上。');
});
test('a numbered restart after a duty heading preserves every subsequent condition', () => {
  const description = '岗位职责\n1. 负责算法研发。\n2. 参与技术部署。\n3. 跟进研究成果。\n1.人工智能、计算机等相关专业；\n2.熟悉通信系统原理；\n3.具有工程实现能力；\n4.发表过论文优先。';
  const out = reviewJobBody({ description });
  assert.equal(out.body_complete, true);
  assert.equal(out.requirements, description.slice(description.indexOf('1.人工智能')));
});
test('short meaningful responsibilities, optional text, aliases and traditional Chinese', () => {
  assert.equal(reviewJobBody({ description: '软件开发与实施部署', requirements: '熟悉SQL，具有编程能力。' }).body_complete, true);
  assert.equal(reviewJobBody({ description: '【職責內容】\n負責校園活動策劃與執行。\n【職位要求】\n香港高校在讀學生，英語流利。' }).body_complete, true);
  assert.equal(reviewJobBody({ description: '职责\n负责设计交互流程。\n硬性要求\n本科学历，熟悉Figma。\n加分项\n具有竞赛经历。' }).body_complete, true);
  const danoneStyle = reviewJobBody({ description: '你将如何发挥你的潜能：\n参与产品价值链质量管理，推动生产质量保证并参与跨部门轮岗。\n我们期待这样的你：\n能够快速学习，拥有全球思维和良好沟通能力。\n专业要求：食品科学与工程类' });
  assert.equal(danoneStyle.body_complete, true);
  assert.match(danoneStyle.requirements, /我们期待这样的你/);
});
