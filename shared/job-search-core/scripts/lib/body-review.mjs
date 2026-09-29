import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {bodyFetch} from './body-fetch.mjs';

// Completeness only. No recruitment/location decisions, matching, network or writes.
export const BODY_REVIEW_VERSION = 2;
export function bodyText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:br\b[^>]*|\/(?:p|div|li|h[1-6]|tr))>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ').replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&#(x[\da-f]+|\d+);/gi, (m, n) => {
      const c = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m;
    }).replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const sha = s => createHash('sha256').update(s).digest('hex');
const meaningful = s => /\p{L}/u.test(s) && !/^(?:test|testing|tbd|n\/?a|none|null|暂无|无|待补充|详见附件|略|测试|测试岗位)[\s.!。]*$/i.test(s.trim());
const aliasReqHeading = /^(?:[一二三四五六七八九十\d]+[、.．）)]\s*)?[【\[（(]?\s*(?:岗位需求|工作要求|技术要求|学历和专业要求|技术技能要求|软性素质要求|期望你是|我们期待这样的你|职位要求|職位要求|應聘條件|基础要求|硬性要求|必备技能要求|应聘资格要求|选拔条件|要求|Job Requirements|Required Qualification|Who We Are Looking For|We Hope You(?: Are)?|We(?:’|')re looking for someone who is)(?:\s*[】\]）)]?\s*[：:]|\s*[】\]）)]?\s*$)/i;
const aliasDutyHeading = /^(?:[一二三四五六七八九十\d]+[、.．）)]\s*)?[【\[（(]?\s*(?:具体工作|你需要做什么|你将如何发挥你的潜能|Job Description|核心职责|職責內容|崗位職責|Here(?:’|')s what you(?:’|')ll do)(?:\s*[】\]）)]?\s*[：:]|\s*[】\]）)]?\s*$)/i;
const bonusHeading = /^(?:加分项|优先条件|加分说明|补充说明|Preferred qualifications|加分项（graduateBonus）|加分项（internBonus）)/i;
const reqHeading = /^(?:(?:[一二三四五六七八九十\d]+)[、.．）)]\s*)?[【\[（(]?\s*(?:(?:任职|岗位|职位|任用|招聘|基本|专业|技能|能力)(?:资格|要求|条件)|任职资格要求|应聘条件|任职资质|招募要求|人才要求|你需要具备|我们(?:希望|期待)你(?:具备|拥有)?|我们需要你|我们想找的|希望你是|招聘对象|招募对象|加分项|优先条件|(?:basic |minimum |preferred |required |desired )?(?:qualifications|requirements)|experience\s*(?:&|and)\s*background|what (?:you (?:bring|need)|we(?:'re| are) looking for)|who you are|skills(?: and experience)?)(?:\s*[\]】）)]?\s*[：:]|\s*[\]】）)]?\s*$)/i;
const dutyHeading = /^(?:(?:[一二三四五六七八九十\d]+)[、.．）)]\s*)?[【\[（(]?\s*(?:(?:岗位|职位|工作|主要|核心)(?:职责|内容|描述|介绍)|职责|轮岗方向|培养方案|工作任务|responsibilities|(?:key |job )responsibilities|what you(?:'|’)ll do|what you will do|your (?:role|mission))(?:\s*[\]】）)]?\s*[：:]|\s*[\]】）)]?\s*$)/i;
const otherHeading = /^(?:[一二三四五六七八九十\d]+[、.．）)]\s*)?(?:其他信息|福利待遇|工作地点|全球热门工作地点|薪资待遇|招聘流程|投递方式|关于我们|公司介绍|about us|benefits)[：:\s]*$/i;
const unbullet = s => s.replace(/^\s*(?:[•●·*\-]|[（(]?[\d一二三四五六七八九十]+[、.．）)])\s*/, '').trim();
const dutyCue = /^(?:(?:你|您|you)\s*(?:将|会|will)\s*)?(?:负责|参与|协助|承担|主导|设计|开发|研发|维护|搭建|建设|推动|推进|完成|跟进|对接|制定|分析|开展|执行|深入|学习并|探索|研究|优化|基于|从事|开发与|软件开发|与.{2,35}(?:一起|合作|协作)|(?:design|develop|build|implement|support|lead|work|collaborate|manage|drive|conduct|analy[sz]e|research|create|responsible for)\b)/i;
const reqCue = /^(?:(?:你|您)\s*)?(?:\d{4}年?(?:应届|届)|全日制|本科|硕士|博士|大学|大专|研究生|计算机.{0,30}专业|具备|具有|拥有|熟悉|熟练|精通|掌握|了解|热爱|喜欢|良好的|较强的|优秀的|有.{1,70}(?:经验|经历|能力|基础)|对.{1,50}(?:了解|兴趣|热情|理解|热爱|认知)|能(?:够|适应|承受)|善于|英语|学历|专业[：:]|(?:bachelor|master|ph\.?d|degree|experience|proficien|strong |excellent |knowledge of|familiar|ability to|fluent|passion for|understanding of)\b)/i;

/** Exact-ID-only extraction from a local API response. A title never joins jobs. */
export function extractRawBody(payload, jobId) {
  const matches = [];
  function walk(v, pointer) {
    if (!v || typeof v !== 'object') return;
    const ids = ['postId', 'id_icims', 'job_id', 'jobid', 'jobId', 'JobAdId', 'Id', 'id', 'jobReqId', 'positionId', 'requisitionId'];
    if (!Array.isArray(v) && ids.some(k => v[k] != null && (typeof v[k] !== 'number' || Number.isSafeInteger(v[k])) && String(v[k]) === String(jobId))) matches.push({ record: v, pointer });
    for (const [k, child] of Object.entries(v)) if (child && typeof child === 'object') walk(child, `${pointer}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`);
  }
  walk(payload, '');
  const fields = ['info_lang', 'topicDetail', 'topicRequirement', 'desc', 'request', 'graduateBonus', 'internBonus',
    'Duty', 'Require', 'DutyStr', 'RequireStr', 'jobDescription', 'description', 'descriptionHtml', 'requirements', 'requirement',
    'workContent', 'serviceCondition', 'jobResponsibility', 'jobRequirements', 'jobinfo', 'basic_qualifications', 'preferred_qualifications'];
  const found = matches.filter(x => fields.some(k => k in x.record));
  if (found.length !== 1) return { error: found.length ? 'ambiguous_exact_id_records' : matches.length ? 'exact_id_record_without_body_fields' : 'no_exact_id_record', matches: found.length };
  const { record: r, pointer } = found[0];
  const descKeys = ['topicDetail', 'desc', 'DutyStr', 'Duty', 'jobDescription', 'description', 'descriptionHtml', 'workContent', 'jobResponsibility', 'jobinfo'];
  const reqKeys = ['topicRequirement', 'request', 'RequireStr', 'Require', 'requirements', 'requirement', 'serviceCondition', 'jobRequirements', 'basic_qualifications'];
  const take = keys => keys.filter(k => meaningful(bodyText(r[k]))).map(k => ({ field: k, text: bodyText(r[k]) }));
  const unique = a => a.filter((x, i) => !a.slice(0, i).some(y => y.text === x.text));
  const d = unique(take(descKeys)), q = unique(take(reqKeys));
  if (r.info_lang && typeof r.info_lang === 'object') {
    const key = meaningful(bodyText(r.info_lang.cn)) ? 'cn' : 'en';
    if (meaningful(bodyText(r.info_lang[key]))) d.push({ field: `info_lang.${key}`, text: bodyText(r.info_lang[key]) });
  }
  // Keep optional qualifications separate; never turn a bonus into a requirement.
  for (const [field, heading] of [['graduateBonus', '补充说明（原字段 graduateBonus）'], ['internBonus', '补充说明（原字段 internBonus）'], ['preferred_qualifications', 'Preferred qualifications']]) {
    if (meaningful(bodyText(r[field]))) q.push({ field, text: `${heading}\n${bodyText(r[field])}` });
  }
  return { description: d.map(x => x.text).join('\n\n'), requirements: q.map(x => x.text).join('\n\n'),
    pointer, fields: [...d, ...q].map(x => x.field), available_fields: Object.fromEntries(fields.filter(k => k in r).map(k => [k, r[k]])) };
}

function inspect(text) {
  const lines = text.split('\n');
  const duties = [], requirements = [], headings = [];
  let section = null, reqStart = -1;
  const reqBlocks = [];
  let offset = 0;
  for (const line of lines) {
    const clean = unbullet(line);
    const r = reqHeading.exec(line.trim()) || aliasReqHeading.exec(line.trim()), d = dutyHeading.exec(line.trim()) || aliasDutyHeading.exec(line.trim());
    const bonus = bonusHeading.test(line.trim());
    if (r || d || bonus || otherHeading.test(line.trim())) {
      if (reqStart >= 0 && !bonus) { reqBlocks.push(text.slice(reqStart, offset).trim()); reqStart = -1; }
      section = bonus ? 'bonus' : r ? 'requirements' : d ? 'duties' : 'other';
      headings.push({ kind: section, text: line, offset });
      if (r && !bonus) reqStart = offset;
      const tail = line.slice((r || d)?.[0].length || line.length).trim();
      if (!bonus && meaningful(tail)) (r ? requirements : duties).push(tail);
    } else if (meaningful(clean)) {
      if (section === 'requirements') requirements.push(line);
      else if (section === 'duties') { if (!reqCue.test(clean)) duties.push(line); }
      else if (section !== 'other' && section !== 'bonus') {
        if (reqCue.test(clean)) requirements.push(line);
        else if (dutyCue.test(clean)) duties.push(line);
      }
    }
    offset += line.length + 1;
  }
  if (reqStart >= 0) reqBlocks.push(text.slice(reqStart).trim());
  return { duties, requirements, headings, reqBlocks };
}

function numberedQualificationTail(text) {
  const entries = [...text.matchAll(/^(\d+)[、.．）)]\s*(.*)$/gm)];
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    if (Number(e[1]) !== 1 || Number(entries[i - 1][1]) < 2) continue;
    const prefix = text.slice(0, e.index), tail = text.slice(e.index);
    if (!inspect(prefix).duties.length || !/(?:专业|学历|毕业生|届|具备|熟悉|degree|experience)/i.test(e[2])) continue;
    if (tail.split('\n').filter(l => reqCue.test(unbullet(l))).length < 2) continue;
    return tail;
  }
  return '';
}

/** Called only by provider normalizers which select their official body fields. */
export function reviewProviderBody(job) {
  const present=[job.description,job.requirements].some(x=>meaningful(bodyText(x)));
  return reviewJobBody({...job,...present&&!job.body_fetch?{body_fetch:{status:'available',origin:'unknown',reason:'provider_official_body_fields'}}:{}});
}

/** Return a new job, preserving the full original body and all unrelated fields.
 * Reads job.raw_file only if supplied; optional job.body_source_files are additional
 * caller-selected local snapshots. No implicit scans or downloads.
 */
export function reviewJobBody(job,{requests=[],rawCache}={}) {
  const identity=[job.company_id||'',String(job.source_job_id??job.job_id??'')];
  const outputHash=j=>sha(JSON.stringify([identity,j.description??'',j.requirements??'']));
  const prior=job.body_review;
  const unchanged=prior?.version===BODY_REVIEW_VERSION&&prior.output_sha256===outputHash(job);
  const original = unchanged?prior.original:{ description: job.description ?? '', requirements: job.requirements ?? '', body_complete: job.body_complete };
  let description = bodyText(original.description), requirements = bodyText(original.requirements);
  const sources = [], rawErrors = [], rawFields = [];
  const files = [...new Set([job.raw_file, ...(job.body_source_files || [])].filter(Boolean))];
  for (const file of files) {
    try {
      let cached=rawCache?.get(file);
      if(!cached){
        const bytes=fs.readFileSync(file),text=bytes.toString('utf8').replace(/^\uFEFF/, '').trim();
        // Decode a single JSONP wrapper as data; never execute callback code.
        const wrapped=text.match(/^[\w$.]+\s*\(([\s\S]*)\)\s*;?\s*$/);
        cached={bytes,payload:JSON.parse(wrapped?wrapped[1]:text)};rawCache?.set(file,cached);
      }
      const {bytes,payload}=cached,raw=extractRawBody(payload,job.source_job_id??job.job_id);
      sources.push({ path: file, sha256: sha(bytes), pointer: raw.pointer ?? null, fields: raw.fields || [], error: raw.error || null });
      if (raw.error) { rawErrors.push(raw.error); continue; }
      rawFields.push(...raw.fields);
      // Retain even differing legacy text; never silently discard sentences.
      const includes = (a, b) => a.replace(/\s/g, '').includes(b.replace(/\s/g, ''));
      if (raw.description && !includes(description, raw.description)) description = meaningful(description) ? `${description}\n\n${raw.description}` : raw.description;
      if (raw.requirements && !includes(requirements, raw.requirements)) requirements = meaningful(requirements) ? `${requirements}\n\n${raw.requirements}` : raw.requirements;
    } catch (error) { rawErrors.push(error.code || 'invalid_local_json'); sources.push({ path: file, error: error.code || 'invalid_local_json' }); }
  }
  const content={description,requirements};
  let fetch=bodyFetch({...job,description,requirements},requests);
  if(fetch.status==='unknown'&&rawFields.length&&(meaningful(description)||meaningful(requirements)))fetch={...fetch,status:'available',reason:'exact_id_official_body_fields'};
  const contentFingerprint=sha(JSON.stringify(content));
  const inputHash=sha(JSON.stringify([identity,content,fetch,sources.map(s=>[s.sha256,s.pointer,s.error])]));
  const di = inspect(description), ri = inspect(requirements);
  const rules = [];
  if (rawFields.some(k => /topicDetail|topicRequirement/.test(k))) rules.push('raw_topic_fields');
  let reqEvidence = ri.requirements;
  if (di.reqBlocks.some(meaningful)) {
    const extracted = di.reqBlocks.join('\n\n');
    if (!meaningful(requirements) || description.replace(/\s/g, '').includes(requirements.replace(/\s/g, ''))) requirements = extracted;
    else if (!requirements.includes(extracted) && !extracted.includes(requirements)) requirements += `\n\n${extracted}`;
    else if (extracted.includes(requirements)) requirements = extracted;
    reqEvidence = [...reqEvidence, ...di.requirements];
    rules.push('explicit_requirement_sections');
  } else if (!meaningful(requirements) && di.duties.length && di.requirements.length >= 2
      && di.duties.every(x => description.indexOf(x) < description.indexOf(di.requirements[0]))) {
    // Headerless mixed/numbered lists: retain each candidate condition verbatim,
    // in order. Ambiguous prose remains pending for human overrides.
    requirements = description.slice(description.indexOf(di.requirements[0])).trim();
    reqEvidence = di.requirements;
    rules.push('headerless_duties_and_multiple_qualification_clauses');
  }
  if (!reqEvidence.length || !meaningful(requirements)) {
    const tail = numberedQualificationTail(description);
    if (tail) { requirements = tail; reqEvidence = inspect(tail).requirements; rules.push('numbered_list_restart_to_qualifications'); }
  }
  const duties = [...di.duties, ...ri.duties];
  if (!meaningful(description) && ri.duties.length) { description = ri.duties.join('\n'); rules.push('duties_in_requirements'); }
  const sections={responsibilities:duties.some(x=>meaningful(unbullet(x)))?'identified':'not_identified',requirements:reqEvidence.some(x=>meaningful(unbullet(x)))?'identified':'not_identified'};
  if(!meaningful(description)&&!meaningful(requirements))sections.responsibilities=sections.requirements='not_evaluated';
  const validOverride=job.body_complete===true&&['manual_full_record_review','model_full_available_body_and_local_evidence_review'].includes(prior?.method)&&prior.version===BODY_REVIEW_VERSION&&prior.input_sha256===inputHash&&prior.output_sha256===outputHash(job)&&fetch.status==='available'&&['duty_clauses','requirement_clauses'].every(k=>prior.evidence?.[k]?.some(q=>meaningful(q)&&(content.description+'\n'+content.requirements).includes(q)));
  if(validOverride)sections.responsibilities=sections.requirements='identified';
  const complete = fetch.status==='available'&&sections.responsibilities==='identified'&&sections.requirements==='identified';
  if (complete && !rules.length) rules.push('distinct_duties_and_qualification_evidence');
  const reason = complete ? '已定位实际工作职责和任职条件；保留原文及加分表述，仅核验正文完整性。'
    : sections.responsibilities==='identified'&&sections.requirements==='identified' ? '文本中已识别职责与任职条件，但完整正文获取证据尚未确认。'
    : !meaningful(description) && !meaningful(requirements) ? '当次可读字段无有效职责或任职条件（空值／占位文本），不能确认完整。'
    : !duties.length ? '未能以安全规则定位实际岗位职责；可能仅有要求、招聘介绍或特殊行文，需逐岗全文判定。'
    : '已有职责，但未能以安全规则定位完整任职条件；需逐岗全文判定。';
  return { ...job, description, requirements, body_fetch:fetch,body_content_fingerprint:contentFingerprint,body_complete: Boolean(complete), body_review: {
    version: BODY_REVIEW_VERSION, scope: 'body_completeness_only', method: validOverride?prior.method:'deterministic_rules', rules, reason,
    sections,input_sha256:inputHash,output_sha256:outputHash({description,requirements}),
    ...(prior?.version!==BODY_REVIEW_VERSION&&prior?{previous_review:prior}:prior?.previous_review?{previous_review:prior.previous_review}:{}),
    source_files: sources.map(x => x.path), sources, raw_errors: rawErrors,
    evidence: validOverride?prior.evidence:{ duty_clauses: duties, requirement_clauses: reqEvidence, headings: [...di.headings, ...ri.headings] },
    original, original_sha256: sha(JSON.stringify(original)), candidate_matching_performed: false,
    downstream_jd_fingerprint_must_be_recomputed: description !== original.description || requirements !== original.requirements,
  } };
}
