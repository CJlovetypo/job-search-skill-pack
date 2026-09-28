// Public API shapes and URL patterns consulted from job-pro (MIT).
// See assets/job-pro-LICENSE.txt. No audit code, browser, or personal session is used at runtime.
import { readFile } from 'node:fs/promises';
import {CUSTOM_PROVIDERS_FILE} from '../../registry.mjs';
import { createClient } from './http.mjs';
import { normalizeJobLocations, jobCityStatus } from './locations.mjs';
import { collectYotta } from './providers-yotta.mjs';
import { collectMicrosoft, collectSap, collectAmazon } from './providers-global.mjs';
import {collectIvva} from './providers-ivva.mjs';
import {collectPublicGame,supportsPublicGame} from './providers-game-public.mjs';
import {collectTongcheng} from './providers-tongcheng.mjs';
import {collectXinrenxinshi} from './providers-xinrenxinshi.mjs';
import {SEARCH_MODE,searchMode,knownOtherType} from './search-mode.mjs';
import {reviewRecruitment} from './recruitment-policy.mjs';

const configuration = JSON.parse(await readFile(CUSTOM_PROVIDERS_FILE, 'utf8')).providers;
const clone = x => structuredClone(x);
const get = (x, p) => p ? p.split('.').reduce((v, k) => v?.[k], x) : undefined;
const set = (x, p, value) => { const keys = p.split('.'); let v = x; for (const k of keys.slice(0, -1)) v = v[k] ||= {}; v[keys.at(-1)] = value; };
const str = x => x == null ? '' : String(x);
const num = x => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null;
const intern = /实习生|实习岗|转正实习|日常实习|暑期实习|\bintern(?:ship)?\b|校园大使|训练营/i;
const graduate = /应届|校招|校园招聘|graduate|freshman/i;

export function cleanCustomText(value) {
  return str(value).replace(/<br\s*\/?\s*>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function places(value, splitSpaces = false) {
  const values = Array.isArray(value) ? value.flatMap(x => places(x, splitSpaces))
    : value && typeof value === 'object' ? places(value.name ?? value.label ?? value.cityName ?? value.addressDetail ?? value.workCity ?? '', splitSpaces)
      : str(value).split(splitSpaces ? /[\s,，、;/；]+/ : /[,，、;/；]+/);
  return [...new Set(values.map(str).map(x => x.trim()).filter(Boolean))];
}

function combined(value) {
  const text = cleanCustomText(value);
  const match = /(?:^|\n)\s*(?:【|\[)?(?:任职资格|任职要求|岗位要求|职位要求|工作要求|招聘要求|Qualifications|Requirements|We are looking for)(?:】|\])?\s*[:：]?/im.exec(text);
  if (!match || match.index < 20) return [text, ''];
  return [text.slice(0, match.index).trim(), text.slice(match.index).trim()];
}

function official(key, j, source, context) {
  const id = encodeURIComponent(str(j.postId ?? j.publishId ?? j.jobUnionId ?? j.positionId ?? j.jobId ?? j.id));
  const listing = source.primary_entry_url || context.config.entry_url;
  const direct = {
    tencent: `https://join.qq.com/post_detail.html?postid=${id}`,
    alibaba: `https://campus-talent.alibaba.com/campus/position/${id}`,
    bytedance: `https://jobs.bytedance.com/campus/position/${id}/detail`,
    baidu: `https://talent.baidu.com/jobs/detail/GRADUATE/${id}`,
    netease: `https://campus.game.163.com/app/detail/index?id=${id}&projectId=${j.projectId ?? context.projectId}`,
    jd: `https://campus.jd.com/#/newDetails?publishId=${id}`,
    meituan: `https://zhaopin.meituan.com/web/position/detail?jobUnionId=${id}&jobShareType=1&highlightType=${String(j.jobType)==='3'?'social':'campus'}`,
    kuaishou: j.code ? `https://campus.kuaishou.cn/recruit/campus/e/#/campus/job-info/?code=${encodeURIComponent(j.code)}` : null,
    bilibili: `https://jobs.bilibili.com/campus/positions/${id}`,
    iqiyi: `https://careers.iqiyi.com/campus/position/${id}/detail`,
    mihoyo: `https://jobs.mihoyo.com/#/${j.hireType===0||/社会招聘/.test([j.hireTypeName,j.projectName].join(' '))||(context.targetMode||source.target_mode||SEARCH_MODE.id)==='social'?'':'campus/'}position/${id}`,
  }[key];
  if (direct) return [direct, 'official_detail'];
  // Use real source-supplied detail links, never an invented URL for an inline JD.
  const supplied = j.jobDetailUrl || j.positionUrl;
  if (supplied && /^https?:\/\//i.test(supplied)) return [supplied, 'official_detail'];
  return listing ? [listing, 'official_listing'] : [null, 'unavailable'];
}

/** Maps public response fields only. A mention of pre-graduation internship in the JD does not change formal status. */
export function normalizeCustomJob(key, j, source, context = {}) {
  const config = context.config || configuration[key]; context = { ...context, config };
  let id, title, loc = [], description = '', requirements = '', formal = 'unknown', open = 'open', evidence = {}, oneBody = false, bodyComplete, rawBodyFields;
  const take = (i, t, l, d, r) => { id = str(i); title = str(t); loc = places(l); description = cleanCustomText(d); requirements = cleanCustomText(r); };
  switch (key) {
    case 'tencent': {
      const duties = cleanCustomText(j.desc), required = cleanCustomText(j.request), bonus = cleanCustomText(j.graduateBonus);
      rawBodyFields = {desc: j.desc ?? null, request: j.request ?? null, graduateBonus: j.graduateBonus ?? null};
      // Keep upstream section semantics; a mandatory submission instruction in
      // graduateBonus stays mandatory according to its wording, not its field name.
      take(j.postId, j.title || j.positionTitle, j.workCityList || places(j.workCities, true),
        duties ? '岗位职责\n' + str(j.desc) : '',
        [required ? '任职要求\n' + str(j.request) : '', bonus ? '加分项（仍以条文措辞判断硬性要求）\n' + str(j.graduateBonus) : ''].filter(Boolean).join('\n\n'));
      // Neither section labels nor bonus-only text supply missing core JD fields.
      bodyComplete = duties.length > 0 && required.length > 0;
      evidence = { recruitType: j.recruitType, recruitLabelName: j.recruitLabelName, projectId: j.projectId, selected_project_mappings: context.projectMappings };
      formal = /实习/.test(j.recruitLabelName || '') ? 'internship' : /应届/.test(j.recruitLabelName || '') || j.recruitType === 1 || context.projectMappings?.some(p => str(p.projectId) === str(j.projectId)) ? 'formal' : 'unknown'; break;
    }
    case 'alibaba':
      take(j.id, j.name, j.workLocations, j.description, j.requirement);
      evidence = { categoryType: j.categoryType, batchId: j.batchId, batchName: j.batchName, graduationTime: j.graduationTime, status: j.status };
      formal = j.categoryType === 'freshman' || context.batch?.type === 'graduate' ? 'formal' : intern.test(j.batchName || '') ? 'internship' : 'unknown';
      open = j.status === 'recruit' ? 'open' : j.status ? 'closed' : 'unknown'; break;
    case 'bytedance': case 'iqiyi':
      take(j.id, j.title, j.city_list?.length ? j.city_list : j.city_info, j.description, j.requirement);
      evidence = { recruit_type: j.recruit_type, job_subject: j.job_subject, query_recruitment_id_list: ['201'] };
      formal = str(j.recruit_type?.id) === '201' ? 'formal' : str(j.recruit_type?.id) === '202' ? 'internship' : str(j.recruit_type?.id) === '101' ? 'social' : 'unknown'; break;
    case 'baidu':
      take(j.postId, j.name, j.workPlace, j.workContent, j.serviceCondition);
      evidence = { projectType: j.projectType, projectTypeCode: j.projectTypeCode, query_recruitType: 'GRADUATE' };
      formal = j.projectType === '校招' || str(j.projectTypeCode) === '1' ? 'formal' : 'unknown'; break;
    case 'netease':
      take(j.id, j.positionName, j.workPlaceName, j.positionDescription, j.positionRequirement);
      evidence = { projectId: j.projectId, projectName: j.projectName || context.projectName, public_current_graduate_navigation: context.projectName };
      formal = graduate.test(evidence.projectName || '') && !intern.test(evidence.projectName || '') ? 'formal' : 'unknown'; break;
    case 'jd':
      take(j.publishId, j.positionName, j.requirementVoList?.flatMap(x => places(x.workCity)) || j.workCity, j.workContent, j.qualification);
      evidence = { list_type: context.jdType, planId: j.planId, planName: j.planName || context.jdPlans?.[j.planId]?.planName, public_project: context.jdPlans?.[j.planId], positionType: j.positionType, positionTypeName: j.positionTypeName };
      formal = intern.test(evidence.planName || '') ? 'internship' : context.jdType === 'present' && evidence.public_project?.project_type === '应届生' ? 'formal' : 'unknown'; break;
    case 'meituan':
      take(j.jobUnionId, j.name, j.cityList, j.jobDuty || j.desc, j.jobRequirement);
      evidence = { jobType: j.jobType, jobSpecialCode: j.jobSpecialCode, projectName: j.projectName, jobStatus: j.jobStatus };
      formal = str(j.jobType) === '1' ? 'formal' : str(j.jobType) === '2' ? 'internship' : str(j.jobType)==='3'?'social':'unknown';
      open = j.jobStatus === '000' ? 'open' : j.jobStatus ? 'closed' : 'unknown'; break;
    case 'antgroup':
      take(j.id, j.name, j.workLocations, j.description, j.requirement);
      evidence = { batchType: j.batchType, batchTypeDesc: j.batchTypeDesc, batchName: j.batchName, graduationTime: j.graduationTime };
      formal = /trainee|intern/i.test(j.batchType || '') || intern.test(j.batchName || '') ? 'internship' : /应届/.test(j.batchTypeDesc || '') || /校招|应届/.test(j.batchName || '') ? 'formal' : 'unknown'; break;
    case 'kuaishou':
      take(j.id, j.name, j.workLocationDicts, j.description, j.positionDemand);
      evidence = { positionNatureCode: j.positionNatureCode, recruitProjectCode: j.recruitProjectCode, recruitSubProjectCode: j.recruitSubProjectCode, positionStatusCode: j.positionStatusCode };
      formal = j.positionNatureCode === 'fulltime' && j.recruitProjectCode === 'schoolr' ? 'formal' : /intern/i.test(j.positionNatureCode || '') ? 'internship' : 'unknown';
      open = j.positionStatusCode === 'Release' ? 'open' : j.positionStatusCode ? 'closed' : 'unknown'; break;
    case 'xiaohongshu':
      take(j.positionId, j.positionName, j.workplace, j.duty, j.qualification);
      evidence = { recruitType: j.recruitType, workExperience: j.workExperience, jobProject: j.jobProject, jobProjectName: j.jobProjectName, recruitStatus: j.recruitStatus };
      formal = j.recruitType === 'intern_recruit' ? 'internship' : j.recruitType === 'school_recruit' ? 'formal' : intern.test(j.jobProjectName || '') ? 'internship' : 'unknown';
      open = j.recruitStatus === 'in_recruitment' ? 'open' : j.recruitStatus ? 'closed' : 'unknown'; break;
    case 'bilibili':
      take(j.id, j.positionName, j.workLocation, ...combined(j.positionDescription)); oneBody = true;
      evidence = { positionTypeName: j.positionTypeName, recruitType: j.recruitType, campusProjectId: j.campusProjectId };
      formal = j.positionTypeName === '全职' && j.recruitType === 1 ? 'formal' : j.positionTypeName === '实习' ? 'internship' : 'unknown'; break;
    case 'pdd':
      take(j.id, j.name, j.workLocationName || j.workLocation, j.jobDuty, j.serveRequirement);
      evidence = { code: j.code, graduationYear: j.graduationYear, recruitTypeName: j.recruitTypeName };
      formal = /^XZ/.test(j.code || '') && j.graduationYear ? 'formal' : 'unknown'; break;
    case 'tme':
      take(j.id, j.name, j.work_city, j.duty, j.requirement);
      evidence = { job_type: j.job_type, job_type_descr: j.job_type_descr };
      formal = j.job_type === 10 || j.job_type_descr === '应届生' ? 'formal' : /实习/.test(j.job_type_descr || '') ? 'internship' : 'unknown'; break;
    case 'shein':
      take(j.jobId, j.jobTitle, j.cityInfos, ...combined(j.description)); oneBody = true;
      evidence = { jobTypeId: j.jobTypeId, releaseDate: j.releaseDate };
      formal = j.jobTypeId === 'CAMPUS' && !intern.test(title) ? 'formal' : j.jobTypeId==='PRACTICE'||intern.test(j.jobTypeId || '') ? 'internship' : j.jobTypeId==='SOCIAL'?'social':'unknown'; break;
    case 'ctrip':
      take(j.fromId || j.id, j.jobTitle, j.cityName, j.duty, j.requirements);
      if (!description && requirements) { [description, requirements] = combined(requirements); oneBody = true; }
      evidence = { category: j.category, kind: j.kind, kindName: j.kindName, publishDate: j.publishDate };
      formal = /intern|实习/i.test(j.kindName || '')||str(j.kind)==='3' ? 'internship' : str(j.category) === '2' && (str(j.kind) === '1' || /Fresh Graduates/i.test(j.kindName || '')) ? 'formal' : str(j.category)==='1'&&str(j.kind)==='1'?'social':'unknown'; break;
    case 'mihoyo':
      take(j.id, j.title, j.addressDetailList, j.description, [j.jobRequire, j.addition, j.deliveryInstructions].filter(Boolean).join('\n\n'));
      evidence = { jobNature: j.jobNature, projectName: j.projectName, hireType: j.hireType, hireTypeName: j.hireTypeName, objectName: j.objectName, jobSummary: j.jobSummary, status: j.status };
      formal = j.jobNature === '实习' ? 'internship' : j.jobNature==='全职'&&(j.hireType===0||/社会招聘/.test([j.hireTypeName,j.projectName].join(' ')))?'social':j.jobNature === '全职' && (/校招|秋招|春招/.test(j.projectName || '') || j.hireType === 1) ? 'formal' : 'unknown';
      if (j.status != null) open = j.status === 1 ? 'open' : 'closed'; break;
    case 'fanruan':
      take(j.id, j.job_name, j.base, j.duty, j.requirement);
      evidence = { mode: j.mode, recruit_type: j.recruit_type, display: j.display };
      formal = j.mode === '校招' && str(j.recruit_type) === '1' ? 'formal' : /实习/.test(j.mode || '') ? 'internship' : 'unknown';
      open = str(j.display) === '1' ? 'open' : 'closed'; break;
    case 'gbits':
      take(j.id, j.postName, j.workAddress, ...combined(j.description)); oneBody = true;
      evidence = { recruitmentType: j.recruitmentType, recruitProjectName: j.recruitProjectName, jobStatus: j.jobStatus, isExternal: j.isExternal };
      formal = j.recruitmentType === '校招正式岗位招聘' ? 'formal' : /实习/.test(j.recruitmentType || '') ? 'internship' : 'unknown';
      open = j.jobStatus === '正常' && j.isExternal === true ? 'open' : 'closed'; break;
    case 'kylinsec':
      take(j.id, j.title, j.city, ...combined(j.content)); oneBody = true;
      evidence = { category_id: j.category_id, ctitle: j.ctitle, experience: j.experience, status: j.status, deadline: j.deadline };
      formal = j.ctitle === '校园招聘' && /应届/.test(j.experience || '') ? 'formal' : intern.test(j.experience || '') ? 'internship' : 'unknown';
      open = j.status === '正常' && (!Number(j.deadline) || Number(j.deadline) * 1000 > Date.now()) ? 'open' : 'closed'; break;
    default: throw new Error(`Missing custom normalization: ${key}`);
  }
  // Title-level internship classification remains distinct from an early internship condition in a formal JD.
  if (intern.test(title)) formal = 'internship';
  const [url, kind] = official(key, j, source, context);
  const complete = bodyComplete ?? (description.length > 0 && (requirements.length > 0 || oneBody));
  return { job_id: id, company_id: source.company_id, company_name: source.display_name, title: title.trim(), locations_raw: loc,
    description, requirements, body_complete: complete, formal_status: formal, open_status: open,
    official_url: url, job_url_kind: kind, recruitment_evidence: { ...evidence, open_basis: 'Current public published-job response; explicit closed flags take precedence.' }, raw_file: context.rawFile || '',
    ...(rawBodyFields ? {raw_metadata: {body_fields: rawBodyFields}} : {}) };
}

function pageRequest(config, template, page, size) {
  const q = clone(template); const u = new URL(q.url);
  const value = config.page_path === 'offset' ? (page - 1) * size : page - 1 + config.page_base;
  if (q.method === 'GET') { u.searchParams.set(config.page_path, value); if (config.size_path) u.searchParams.set(config.size_path, size); }
  else if (typeof q.body === 'string') { const b = new URLSearchParams(q.body); b.set(config.page_path, value); if (config.size_path) b.set(config.size_path, size); q.body = b.toString(); }
  else { q.body ||= {}; set(q.body, config.page_path, value); if (config.size_path) set(q.body, config.size_path, size); }
  q.url = u.href; return q;
}

function detailRequest(key, config, id, context = {}) {
  const q = clone(config.detail_request); if (!q) return null;
  const u = new URL(q.url);
  if (key === 'tencent') u.searchParams.set('postId', id);
  else if (key === 'tme') u.searchParams.set('id', id);
  else if (key === 'xiaohongshu') u.searchParams.set('positionId', id);
  else if (key === 'netease') { u.searchParams.set('id', id); if (context.projectId) u.searchParams.set('projectId', context.projectId); }
  else if (key === 'mihoyo') q.body.id = id;
  else if (key === 'jd') u.pathname = u.pathname.replace(/\/[^/]+$/, '/' + encodeURIComponent(id));
  else if (key === 'meituan') q.body.jobUnionId = id;
  else if (key === 'pdd') q.body.id = id;
  else return null;
  q.url = u.href; return q;
}

function cityMatch(job, cities) { const loc=normalizeJobLocations(job);return jobCityStatus({cities:loc.cities,location_special:loc.special,location_unknown:loc.unknown},cities||[])!=='excluded'; }

/** Enumerate each live public campus stream; then fetch only missing bodies/type evidence. */
export async function collectCustom(source, options = {}) {
  if(supportsPublicGame(source))return collectPublicGame(source,options);
  if(source.provider==='tongcheng')return collectTongcheng(source,options);
  if(source.provider==='xinrenxinshi')return collectXinrenxinshi(source,options);
  if(source.provider==='amazon_jobs')return collectAmazon(source,options);
  if(source.provider==='ivva')return collectIvva(source,options);
  if(source.provider==='microsoft_eightfold')return collectMicrosoft(source,options);
  if(source.provider==='sap_rss')return collectSap(source,options);
  if(source.provider==='yotta')return collectYotta(source,options);
  options = { mode: 'full', ...options };
  const pair = Object.entries(configuration).find(([, c]) => c.company_name === source.display_name)
    || Object.entries(configuration).find(([, c]) => c.provider === source.provider && source.provider !== 'first_party');
  if (!pair) return null;
  const [key, originalConfig] = pair, config=clone(originalConfig),targetMode=options.targetMode||SEARCH_MODE.id,client = createClient(options), pages = [], all = new Map(), streams = [], failures = [];
  if(targetMode!=='campus')for(const q of config.list_requests) {
    if(key==='meituan')q.body.jobType=[{code:targetMode==='internship'?'2':'3',subCode:[]}];
    if(key==='mihoyo')q.body.hireType=targetMode==='social'?0:1;
    if(key==='ctrip')delete q.body.condition.category;
    if(key==='shein')q.body.jobTypeIds=[targetMode==='social'?'SOCIAL':'PRACTICE'];
  }
  const checked = new Date().toISOString(); let size = config.fixed_page_size || Math.max(1, Math.min(config.max_page_size || 100, options.pageSize || 20));
  // This exact upstream size fails on page 1. Keep a consistent size for every page rather than shifting offsets mid-stream.
  if (key === 'kuaishou' && size === 10) size = 11;
  const maxPages = Math.max(1, options.maxPages ?? 1000); let token = null, completeStreams = 0;
  const totals = new Map();
  async function request(q, purpose) {
    q = clone(q);
    if (key === 'alibaba' && purpose !== 'public_bootstrap') {
      const cookie = client.cookieValue('XSRF-TOKEN', q.url); if (!cookie) throw new Error('Public Alibaba bootstrap did not issue XSRF-TOKEN');
      q.headers['X-XSRF-TOKEN'] = decodeURIComponent(cookie);
    }
    if (key === 'bilibili' && token) q.headers['X-CSRF'] = token;
    if (key === 'tencent') { const u = new URL(q.url); u.searchParams.set('timestamp', Date.now()); q.url = u.href; }
    const response = await client.request(q, { purpose });
    if (response.record.http_status !== 200) throw new Error(`HTTP ${response.record.http_status}: ${q.url}`);
    if (purpose !== 'public_bootstrap' && response.data === null) throw new Error('Public API returned non-JSON');
    return response;
  }
  try {
    for (const q of config.bootstrap_requests) await request(q, 'public_bootstrap');
    const context = { config,targetMode };
    for (const q of config.discovery_requests) {
      const res = await request(q, key === 'bilibili' ? 'public_csrf_bootstrap' : 'public_project_discovery');
      if (key === 'tencent') {
        context.projectMappings = (res.data.data || []).flatMap(x => (x.subProjectList || []).filter(y => y.status === 1 && (targetMode==='internship'?/实习/.test(y.projectName):!/实习/.test(y.projectName) && (y.recruitType === 1 || /应届|培训生/.test(y.projectName)))).map(y => ({ ...y })));
        if (!context.projectMappings.length) throw new Error('No active graduate project mappings');
      } else if (key === 'alibaba') {
        const batches = res.data.content?.graduate || [];
        for (const batch of batches) { const template = clone(config.list_requests[0]); template.body.batchId = batch.id; streams.push({ template, context: { config, batch } }); }
        if (!streams.length) throw new Error('No current graduate batch');
      } else if (key === 'netease') {
        const grad = (res.data.data || []).filter(x => (targetMode==='internship'?/实习/:/应届/).test(x.name));
        for (const p of grad.flatMap(x => x.children || [])) {
          const projectId = new URL(p.link, config.entry_url).searchParams.get('id'); if (!projectId || p.status !== 1) continue;
          const template = clone(config.list_requests[0]), u = new URL(template.url); u.searchParams.set('projectId', projectId); template.url = u.href;
          streams.push({ template, context: { config, projectId, projectName: p.name } });
        }
        if (!streams.length) throw new Error('No currently published graduate project in public navigation');
      } else if (key === 'bilibili') {
        token = res.data.data; if (typeof token !== 'string' || !token) throw new Error('Missing public CSRF token');
        client.setCookie('X-CSRF', token, q.url, { sourceRecord: res.record });
      } else if (key === 'jd') {
        context.jdPlans = {};
        for (const project of res.data.body?.projectList || []) {
          if (project.release !== true) continue;
          for (const plan of (project.groupList || []).flatMap(g => g.planMapList || [])) context.jdPlans[plan.id] = { ...plan, project_type: project.type, project_code: project.code, raw_file: res.record.response_file };
        }
        if (!Object.keys(context.jdPlans).length) throw new Error('No current public JD project definitions');
      }
    }
    if (!streams.length) for (const original of config.list_requests) {
      const template = clone(original);
      if (key === 'tencent') template.body.projectMappingIdList = context.projectMappings.map(x => x.mappingId);
      if (key === 'iqiyi') template.body.recruitment_id_list = ['201'];
      streams.push({ template, context: { ...context, jdType: key === 'jd' ? new URL(template.url).searchParams.get('type') : undefined } });
    }
    for (let streamIndex = 0; streamIndex < streams.length; streamIndex++) {
      const stream = streams[streamIndex], seen = new Set(); let ended = false, streamTotal = null;
      let errored = false;
      try {
      for (let page = 1; pages.length < maxPages; page++) {
        const res = await request(pageRequest(config, stream.template, page, size), 'job_list');
        const rows = get(res.data, config.items_path);
        if (!Array.isArray(rows)) throw new Error(`Changed public list schema: ${config.items_path}`);
        streamTotal = num(get(res.data, config.total_path));
        totals.set(streamIndex, streamTotal);
        const ids = []; let newCount = 0;
        for (const raw of rows) {
          const ctx = { ...stream.context, rawFile: res.record.response_file }, job = normalizeCustomJob(key, raw, source, ctx);
          if (!job.job_id || !job.title) throw new Error('Published row missing stable ID/title');
          ids.push(job.job_id); if (!seen.has(job.job_id)) newCount++; seen.add(job.job_id);
          if (!all.has(job.job_id)) all.set(job.job_id, { job, raw, context: ctx });
          else {
            const previous = all.get(job.job_id);
            previous.job.locations_raw = [...new Set([...previous.job.locations_raw, ...job.locations_raw])];
            previous.job.recruitment_evidence.additional_list_files = [...new Set([...(previous.job.recruitment_evidence.additional_list_files || []), job.raw_file])];
            if (previous.job.formal_status !== job.formal_status) {
              previous.job.recruitment_evidence.conflicting_recruitment_types = [...new Set([...(previous.job.recruitment_evidence.conflicting_recruitment_types || []), previous.job.formal_status, job.formal_status])];
              previous.job.formal_status = 'unknown';
            }
          }
        }
        const evidence = { stream: streamIndex + 1, page, request_url: res.record.url, request_body: res.record.body, raw_file: res.record.response_file, job_ids: ids, new_ids: newCount, server_total: streamTotal, end_evidence: null };
        pages.push(evidence);
        const declaredTerminal = key === 'kylinsec' && res.data.more === 0 || key === 'fanruan' && Number(res.data.curPage) >= Number(res.data.pageTotal)
          || key === 'meituan' && Number(res.data.data?.page?.totalPage) > 0 && Number(res.data.data.page.pageNo) >= Number(res.data.data.page.totalPage);
        if (!rows.length || (streamTotal !== null && seen.size >= streamTotal) || declaredTerminal) {
          evidence.end_evidence = !rows.length ? 'empty_page' : key === 'kylinsec' ? 'more=0' : 'server_total_or_terminal_page_reached';
          if (streamTotal !== null && seen.size !== streamTotal) {
            evidence.end_evidence += '_unique_count_mismatch'; failures.push(`Stream ${streamIndex + 1}: endpoint terminal signal but ${seen.size}/${streamTotal} unique IDs observed`);
          }
          ended = true; break;
        }
        if (!newCount) { evidence.end_evidence = 'repeated_page_with_no_new_ids'; failures.push(`Stream ${streamIndex + 1}: repeated page ${page}; ${seen.size}/${streamTotal ?? '?'} rows observed`); break; }
      }
      } catch (error) { errored = true; failures.push(`Stream ${streamIndex + 1}: ${error.message}`); }
      if (ended) completeStreams++; else if (!errored && pages.length >= maxPages && pages.at(-1)?.end_evidence !== 'repeated_page_with_no_new_ids') failures.push(`Stream ${streamIndex + 1}: maxPages reached before an endpoint terminal signal`);
      if (pages.length >= maxPages) break;
    }
    for(const item of all.values())if((options.targetMode||SEARCH_MODE.id)!=='campus')item.job=reviewRecruitment(item.job,options.targetMode||SEARCH_MODE.id);
    const pending = [...all.values()].filter(({ job }) => job.open_status !== 'closed' && ((options.targetMode||SEARCH_MODE.id)==='campus'?!['internship', 'social'].includes(job.formal_status):!knownOtherType(job,options.targetMode||SEARCH_MODE.id))
      && (key === 'xiaohongshu' && job.formal_status === 'unknown' || options.mode === 'full' && (!job.body_complete || key === 'tme' && job.formal_status === 'unknown'))
      && (!options.titleFilter||options.titleFilter(job.title)) && (options.mode !== 'full' || cityMatch(job, options.cities)) && config.detail_request);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (next < pending.length) {
        const item = pending[next++];
        try {
          const q = detailRequest(key, config, item.job.job_id, item.context); if (!q) continue;
          const res = await request(q, 'job_detail'), raw = res.data.data ?? res.data.body ?? res.data.result;
          if (!raw || typeof raw !== 'object') throw new Error('Missing detail JSON object');
          const job = normalizeCustomJob(key, { ...item.raw, ...raw }, source, { ...item.context, rawFile: res.record.response_file });
          if (job.job_id !== item.job.job_id) throw new Error('Detail returned a different job ID');
          job.locations_raw = [...new Set([...item.job.locations_raw, ...job.locations_raw])];
          job.recruitment_evidence.list_file = item.context.rawFile;
          item.job = job;
        } catch (error) { failures.push(`Detail ${item.job.job_id}: ${error.message}`); }
      }
    }));
  } catch (error) { failures.push(error.message); }
  const jobs = [...all.values()].map(x => targetMode==='campus'?x.job:reviewRecruitment(x.job,targetMode));
  const unknown = jobs.filter(j => j.formal_status === 'unknown' && j.open_status !== 'closed').length;
  const incomplete = options.mode === 'full' ? jobs.filter(j => j.formal_status === searchMode(options.targetMode||SEARCH_MODE.id).status && j.open_status !== 'closed' && cityMatch(j, options.cities) && !j.body_complete).length : 0;
  if (unknown) failures.push(`${unknown} published jobs have unconfirmed recruitment type`);
  if (incomplete) failures.push(`${incomplete} ${searchMode(targetMode).label} jobs lack a complete JD`);
  const complete = streams.length > 0 && completeStreams === streams.length && !failures.length;
  const serverTotal = totals.size === streams.length && totals.size && [...totals.values()].every(x => x !== null) ? [...totals.values()].reduce((a,b) => a+b, 0) : null;
  return { company_id: source.company_id, display_name: source.display_name, checked_at: checked, jobs,
    coverage: { status: complete ? 'complete' : pages.length ? 'partial' : 'failed', pages, server_total: serverTotal, jobs_observed: jobs.length,
      reason: failures.join('; ') || 'All configured live public campus streams reached an observed terminal signal',
      mode: options.mode || 'full', formal_type_unknown: unknown, incomplete_formal_bodies: incomplete,
      scope: key === 'netease' ? '网易互娱游戏校招分支；不代表网易集团所有业务' : 'Configured verified API streams only; not every group subsidiary or recruitment portal' }, requests: client.records };
}
