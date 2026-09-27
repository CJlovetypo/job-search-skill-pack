import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {profileFingerprint, profileEvidenceProblem, abilityEvidenceProblem} from '../lib/evidence-model.mjs';

const evidence = (overrides = {}) => ({
  id: 'E1', text: '测试材料：独立完成课程用户研究，访谈 12 名用户并提交可追踪的分析报告。',
  source: '测试简历第 1 页', kind: 'resume', claim_type: 'objective_experience',
  experience_type: 'course_project', experience_id: 'P1', ...overrides,
});
const profile = (overrides = {}) => ({
  is_test: true, summary: '仅供测试的校园项目画像。', graduation: {year: 2027, degree: '本科'},
  city_filters: ['上海'], role_preferences: ['用户研究'], evidence: [evidence()], ...overrides,
});
const comparison = (overrides = {}) => ({
  jd_requirement: '独立组织访谈并整理研究发现', explanation: '项目提供具体行动与可追踪产物，直接对应该职责。',
  requirement_type: 'core', support: 'direct', evidence_strength: 'strong', profile_evidence_ids: ['E1'], ...overrides,
});
const review = (overrides = {}) => ({
  ability: 'high', ability_reason: '课程项目有明确个人职责和可追踪成果，直接覆盖该岗位核心研究要求。',
  comparisons: [comparison()], ...overrides,
});
const relevance = (overrides = {}) => ({
  experience_id: 'I1', industry_relation: 'same', business_relation: 'same', role_relation: 'same',
  explanation: '测试材料显示处于相同的行业、部门业务与职能；具体职责证据另在要求对照中说明。', ...overrides,
});

test('画像指纹递归忽略对象键顺序，并且不修改输入', () => {
  const original = profile();
  const before = structuredClone(original);
  const reversed = value => Array.isArray(value) ? value.map(reversed) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)])) : value;
  assert.match(profileFingerprint(original), /^[0-9a-f]{64}$/);
  assert.equal(profileFingerprint(original), profileFingerprint(reversed(original)));
  assert.deepEqual(original, before);
});

test('相同证据 ID 不掩盖正文、分类、摘要、毕业、偏好及测试标记变化', () => {
  const original = profile();
  const mutations = [
    value => { value.evidence[0].text = '测试材料：只旁听了课程，没有执行项目。'; },
    value => { value.evidence[0].claim_type = 'self_assessment'; },
    value => { value.evidence[0].experience_type = 'internship'; },
    value => { value.evidence[0].source = '测试用户补充'; },
    value => { value.summary = '另一位测试候选人。'; },
    value => { value.graduation.year = 2025; },
    value => { value.role_preferences = ['数据分析']; },
    value => { value.city_filters = ['杭州']; },
    value => { value.is_test = false; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.equal(changed.evidence[0].id, original.evidence[0].id);
    assert.notEqual(profileFingerprint(changed), profileFingerprint(original));
  }
});

test('画像证据须有唯一 ID、内容、来源和明确分类', () => {
  assert.equal(profileEvidenceProblem(profile()), null);
  for (const invalid of [undefined, {}, profile({evidence: []}), profile({evidence: [null]})]) assert.ok(profileEvidenceProblem(invalid));
  for (const field of ['id', 'text', 'source', 'kind', 'claim_type', 'experience_type']) {
    assert.ok(profileEvidenceProblem(profile({evidence: [evidence({[field]: undefined})]})), field);
  }
  assert.match(profileEvidenceProblem(profile({evidence: [evidence(), evidence()]})), /ID 重复/);
  for (const override of [{experience_type: 'none'}, {experience_id: null}, {experience_id: '  '}]) {
    assert.match(profileEvidenceProblem(profile({evidence: [evidence(override)]})), /客观证据/);
  }
  for (const kind of ['resume', 'self_description', 'user_clarification']) {
    assert.equal(profileEvidenceProblem(profile({evidence: [evidence({kind})]})), null);
  }
});

test('来源与客观性独立：简历自评和用户偏好均可明确标注 none/null', () => {
  for (const claim_type of ['self_assessment', 'preference']) {
    assert.equal(profileEvidenceProblem(profile({evidence: [evidence({claim_type, experience_type: 'none', experience_id: null})]})), null);
  }
  assert.match(profileEvidenceProblem(profile({evidence: [evidence({claim_type: 'self_assessment', experience_type: 'none', experience_id: 123})]})), /experience_id/);
});

test('仅有主观自评不能支撑高或中能力，也不能冒充 strong/moderate', () => {
  const self = profile({evidence: [evidence({text: '测试自评：沟通能力强。', claim_type: 'self_assessment', experience_type: 'none', experience_id: null})]});
  for (const ability of ['high', 'medium']) {
    assert.match(abilityEvidenceProblem(review({ability, comparisons: [comparison({evidence_strength: 'weak'})]}), self), /客观经历或成就支持/);
  }
  for (const evidence_strength of ['strong', 'moderate']) {
    assert.match(abilityEvidenceProblem(review({comparisons: [comparison({evidence_strength})]}), self), /不能仅凭自评或偏好/);
  }
});

test('高质量学校或个人项目可支持 high，不以实习为硬门槛', () => {
  for (const experience_type of ['research_project', 'course_project', 'personal_project']) {
    assert.equal(abilityEvidenceProblem(review(), profile({evidence: [evidence({experience_type})]})), null);
  }
});

test('仅有实习头衔的 weak 证据不能评 high 或 medium', () => {
  const titleOnly = profile({evidence: [evidence({text: '测试简历只记载某公司实习生头衔，未记载职责或成果。', experience_type: 'internship', experience_id: 'I1'})]});
  for (const ability of ['high', 'medium']) {
    assert.match(abilityEvidenceProblem(review({ability, experience_relevance: [relevance()], comparisons: [comparison({evidence_strength: 'weak'})]}), titleOnly), /客观.*weak/);
  }
});

test('加分项缺口不阻止 high，全部核心须直接覆盖且至少一项强证据', () => {
  const bonus = comparison({requirement_type: 'bonus', support: 'unsupported', evidence_strength: 'none', profile_evidence_ids: []});
  assert.equal(abilityEvidenceProblem(review({comparisons: [comparison(), bonus]}), profile()), null);
  assert.equal(abilityEvidenceProblem(review({comparisons: [comparison(), comparison({evidence_strength: 'moderate'})]}), profile()), null);
  for (const secondCore of [
    comparison({support: 'unsupported', evidence_strength: 'none', profile_evidence_ids: []}),
    comparison({support: 'transferable', evidence_strength: 'moderate'}),
    comparison({evidence_strength: 'weak'}),
  ]) assert.match(abilityEvidenceProblem(review({comparisons: [comparison(), secondCore]}), profile()), /核心缺口不能评高/);
  assert.match(abilityEvidenceProblem(review({comparisons: [comparison({evidence_strength: 'moderate'})]}), profile()), /至少须有一项核心/);
});

test('资格证据不能代替核心覆盖，也不能独撑中能力', () => {
  const eligibility = comparison({requirement_type: 'eligibility'});
  assert.match(abilityEvidenceProblem(review({comparisons: [eligibility]}), profile()), /至少须有一项 core/);
  const unsupportedCore = comparison({support: 'unsupported', evidence_strength: 'none', profile_evidence_ids: []});
  assert.match(abilityEvidenceProblem(review({ability: 'medium', comparisons: [unsupportedCore, eligibility]}), profile()), /客观经历或成就支持/);
});

test('只有核心自评与加分项客观证书不能评 medium，核心或支持要求有中强度迁移证据才可支持', () => {
  const mixed = profile({evidence: [
    evidence({id: 'E1', text: '测试自评：擅长用户研究。', claim_type: 'self_assessment', experience_type: 'none', experience_id: null}),
    evidence({id: 'E2', text: '测试材料：取得一项加分证书。', claim_type: 'objective_achievement', experience_type: 'other', experience_id: 'C1'}),
    evidence({id: 'E3'}),
  ]});
  const coreSelf = comparison({evidence_strength: 'weak'});
  const certificate = comparison({requirement_type: 'bonus', profile_evidence_ids: ['E2']});
  assert.match(abilityEvidenceProblem(review({ability: 'medium', comparisons: [coreSelf, certificate]}), mixed), /客观.*加分项/);
  for (const requirement_type of ['core', 'supporting']) {
    const transferable = comparison({requirement_type, support: 'transferable', evidence_strength: 'moderate', profile_evidence_ids: ['E3']});
    assert.equal(abilityEvidenceProblem(review({ability: 'medium', comparisons: [coreSelf, certificate, transferable]}), mixed), null);
  }
});

test('同一 experience_id 可拆出多条证据，拆条本身不会绕过核心评级要求', () => {
  const pieces = profile({evidence: [evidence(), evidence({id: 'E2', claim_type: 'objective_achievement', text: '测试材料：同一研究项目形成两条已采纳建议。'})]});
  assert.equal(profileEvidenceProblem(pieces), null);
  assert.equal(abilityEvidenceProblem(review({comparisons: [comparison({profile_evidence_ids: ['E1', 'E2']})]}), pieces), null);
  assert.match(abilityEvidenceProblem(review({comparisons: [comparison({evidence_strength: 'weak', profile_evidence_ids: ['E1', 'E2']})]}), pieces), /客观.*weak/);
});

test('同一实际经历的类型须一致，自评 none 或无经历 ID 不要求补造类型', () => {
  const contradictory = profile({evidence: [evidence(), evidence({id: 'E2', experience_type: 'internship'})]});
  assert.match(profileEvidenceProblem(contradictory), /同一 experience_id.*不一致/);
  for (const self of [
    evidence({id: 'E2', claim_type: 'self_assessment', experience_type: 'none'}),
    evidence({id: 'E2', claim_type: 'preference', experience_type: 'none', experience_id: null}),
  ]) assert.equal(profileEvidenceProblem(profile({evidence: [evidence(), self]})), null);
});

test('结构不完整或对照标记相互矛盾时返回问题，不自动生成评分', () => {
  for (const ability_reason of [undefined, '', ' \n ', {}]) assert.match(abilityEvidenceProblem(review({ability_reason}), profile()), /ability_reason/);
  for (const field of ['requirement_type', 'support', 'evidence_strength']) {
    assert.match(abilityEvidenceProblem(review({comparisons: [comparison({[field]: undefined})]}), profile()), new RegExp(field));
  }
  for (const support of ['direct', 'transferable']) {
    for (const change of [{profile_evidence_ids: []}, {evidence_strength: 'none'}]) assert.match(abilityEvidenceProblem(review({comparisons: [comparison({support, ...change})]}), profile()), /direct\/transferable/);
  }
  assert.match(abilityEvidenceProblem(review({comparisons: [comparison({profile_evidence_ids: ['E404']})]}), profile()), /不存在的个人证据/);
  assert.match(abilityEvidenceProblem(review({comparisons: [comparison({support: 'unsupported'})]}), profile()), /必须为 none/);
  assert.equal(abilityEvidenceProblem(review({ability: 'low', comparisons: [comparison({support: 'unsupported', evidence_strength: 'none', profile_evidence_ids: []})]}), profile()), null);
  assert.equal(abilityEvidenceProblem(review({ability: 'medium', comparisons: [comparison({support: 'transferable', evidence_strength: 'moderate'})]}), profile()), null);
});

test('同职能跨业务、同业务跨职能及信息未知的三维对口记录合法，不按单维不同自动降能力', () => {
  for (const experience_type of ['internship', 'employment']) {
    const workProfile = profile({evidence: [evidence({experience_type, experience_id: 'I1'})]});
    for (const dimensions of [
      {industry_relation: 'different', business_relation: 'different', role_relation: 'same'},
      {industry_relation: 'same', business_relation: 'same', role_relation: 'different'},
      {industry_relation: 'adjacent', business_relation: 'adjacent', role_relation: 'same'},
      {industry_relation: 'unknown', business_relation: 'unknown', role_relation: 'unknown'},
    ]) assert.equal(abilityEvidenceProblem(review({experience_relevance: [relevance(dimensions)]}), workProfile), null);
  }
});

test('引用实习客观证据必须逐经历完整说明三维，缺项、重复、未知或非工作经历 ID 拒绝', () => {
  const workProfile = profile({evidence: [evidence({experience_type: 'internship', experience_id: 'I1'})]});
  for (const experience_relevance of [undefined, null, {}, []]) {
    assert.match(abilityEvidenceProblem(review({experience_relevance}), workProfile), /experience_relevance/);
  }
  for (const field of ['industry_relation', 'business_relation', 'role_relation', 'explanation']) {
    assert.match(abilityEvidenceProblem(review({experience_relevance: [relevance({[field]: undefined})]}), workProfile), new RegExp(field));
  }
  assert.match(abilityEvidenceProblem(review({experience_relevance: [relevance(), relevance()]}), workProfile), /experience_id 重复/);
  assert.match(abilityEvidenceProblem(review({experience_relevance: [relevance({experience_id: 'I404'})]}), workProfile), /不存在或非实习\/工作/);
  assert.match(abilityEvidenceProblem(review({experience_relevance: [relevance({experience_id: 'P1'})]}), profile()), /不存在或非实习\/工作/);
});

test('三维对口判断按独立工作经历归并，覆盖所有引用的经历且不要求无工作证据画像补造记录', () => {
  const workProfile = profile({evidence: [
    evidence({experience_type: 'internship', experience_id: 'I1'}),
    evidence({id: 'E2', claim_type: 'objective_achievement', experience_type: 'internship', experience_id: 'I1'}),
    evidence({id: 'E3', experience_type: 'employment', experience_id: 'W2'}),
  ]});
  assert.equal(abilityEvidenceProblem(review({comparisons: [comparison({profile_evidence_ids: ['E1', 'E2']})], experience_relevance: [relevance()]}), workProfile), null);
  const comparisons = [comparison({profile_evidence_ids: ['E1', 'E2', 'E3']})];
  assert.match(abilityEvidenceProblem(review({comparisons, experience_relevance: [relevance()]}), workProfile), /缺少.*W2/);
  assert.equal(abilityEvidenceProblem(review({comparisons, experience_relevance: [relevance(), relevance({experience_id: 'W2'})]}), workProfile), null);
  for (const experience_relevance of [undefined, []]) assert.equal(abilityEvidenceProblem(review({experience_relevance}), profile()), null);
});
