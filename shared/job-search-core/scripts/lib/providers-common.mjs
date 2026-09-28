import { createDecipheriv, randomUUID } from 'node:crypto';
import { createClient, saveDecoded } from './http.mjs';
import { normalizeJobLocations, jobCityStatus } from './locations.mjs';
import { reviewRecruitment } from './recruitment-policy.mjs';
import {SEARCH_MODE,searchMode,knownOtherType} from './search-mode.mjs';

const supported = new Set(['moka', 'moka_api_platform', 'beisen', 'feishu', 'hotjob']);
const reqMarker = /(?:任职|岗位|职位|任用|招聘|基本)(?:资格|要求|条件)|专业要求|学历要求|(?:^|\n)\s*(?:专业|学历|要求|如果你(?:是)?|我们需要你)\s*[：:]|我们希望你|我们期待(?:这样的)?你|希望你是|我们想找的|你需要具备|Qualifications|Requirements|What you bring|Who you are/i;
const dutyMarker = /职责|工作内容|职位描述|岗位描述|岗位介绍|你将|Responsibilities|What you(?:'|’)ll|Your (?:role|mission)/i;

function htmlDecode(value) {
  return String(value ?? '').replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function text(value) {
  return htmlDecode(value).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:br\s*\/?|\/p|\/div|\/li|\/h[1-6])>/gi, '\n').replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function bodyParts(description, requirements = '') {
  const body = text(description), req = text(requirements);
  if (req) return { description: body, requirements: req, body_complete: body.length > 15 && req.length > 15 };
  const marker = body.match(reqMarker);
  const duties = dutyMarker.test(body);
  const split = marker ? body.slice(marker.index) : '';
  return { description: body, requirements: split, body_complete: duties && !!marker && body.length > 35 && split.length > 20 };
}
export const splitCommonBody=bodyParts;

function locations(d, provider) {
  let values = [];
  if (provider === 'beisen') values = [...(d.LocNames || []), ...(Array.isArray(d.LocId) ? d.LocId : [])];
  else if (provider === 'hotjob') values = [...(d.workPlaceList || []), d.workPlaceStr];
  else if (provider === 'feishu') values = [...(d.city_list || []), d.city_info, ...(d.job_post_info?.address_list || [])];
  else values = [...(d.locations || []), d.location, ...(d.workLocations || [])];
  const result = [];
  for (const value of values.filter(Boolean)) {
    if (typeof value === 'string') { if (!/^\d+$/.test(value)) result.push(value); continue; }
    if (typeof value !== 'object') continue;
    const city = value.cityName || value.city_name || (typeof value.city === 'string' ? value.city : value.city?.name || value.city?.cityName)
      || value.location?.cityName || value.name || value.label || value.i18n_name;
    const province = value.provinceName || value.province || value.state?.name;
    // Moka's cityName may actually be a district (e.g. 海淀区). Never discard its explicit parent.
    const parts = [...new Set([province, city].filter(v => typeof v === 'string' && v.trim()))];
    if (parts.length) result.push(parts.join('·'));
  }
  return [...new Set(result.map(v => v.trim()).filter(Boolean))];
}

function explicitInternTitle(title) {
  // “可提前实习的正式校招” and “实习经历优先” describe conditions, not the employment type.
  const cleaned = title.replace(/(?:需|可|要求|接受)?提前实习/g, '').replace(/实习经历.{0,4}(?:优先|加分)/g, '');
  return /^实习|实习(?:生|转正|工程师|开发|算法|设计|产品|岗位|岗|助理)|转正实习|(?:^|[-—_/（(【［\[\s])实习(?:[-—_/）)】］\]\s]|$)|intern(?:ship)?\b/i.test(cleaned);
}

function classify(d, provider, campusContext, targetMode=SEARCH_MODE.id) {
  const title = d.title || d.JobAdName || d.postName || d.name || '';
  const recruitType = d.recruit_type || d.job_post_info?.recruitment_type;
  const type = String(d.commitment || d.Kind || d.hireTypeDesc || recruitType?.name || '').trim();
  const campusLabel = d.Category || recruitType?.parent?.name || '';
  const evidence = { provider, campus_context: campusContext };
  if (d._requested_recruitment_ids?.length) evidence.query_recruitment_id_list = d._requested_recruitment_ids;
  let formal = 'unknown', open = 'unknown';
  if (/实习|intern/i.test(type) || explicitInternTitle(title)) formal = 'internship';
  else if (/社招|社会招聘/.test(campusLabel) || recruitType?.id === '1' || (provider === 'hotjob' && Number(d.recruitType) === 2)) formal = 'social';
  else if (/训练营|夏令营|校园大使|博士后/.test(title)) formal = 'unknown';
  else if (provider === 'beisen' && /校招|校园招聘|应届/.test(campusLabel) && /^(全职|正式)$/.test(type)) formal = 'formal';
  else if (provider === 'feishu' && /^(正式|全职)$/.test(type) && (/校招|校园招聘/.test(campusLabel) || recruitType?.id === '201')) formal = 'formal';
  else if (provider === 'feishu' && !recruitType && d._requested_recruitment_ids?.length === 1 && d._requested_recruitment_ids[0] === '201'
    && /校招|校园招聘|(?:20)?2\d\s*届(?:应届|毕业|校招|秋|春|本科|硕士)|(?:20)?2\d\s*届/.test([title, d.job_subject?.name?.zh_cn, d.job_subject?.name?.i18n, d.requirement].filter(Boolean).join('\n'))) {
    formal = 'formal';
    evidence.formal_basis = 'Current public API query explicitly filters known formal-campus type 201, corroborated by this job’s campus/cohort title, project or requirement; missing response label is preserved.';
    evidence.query_recruitment_id_list = d._requested_recruitment_ids;
    evidence.cohort_corroboration = [title, d.job_subject?.name?.zh_cn, d.requirement].filter(Boolean).join('\n').match(/.{0,20}(?:校招|校园招聘|(?:20)?2\d\s*届).{0,60}/g)?.slice(0,3);
  }
  else if (['moka', 'moka_api_platform'].includes(provider) && campusContext && /^(全职|正式|full.?time)$/i.test(type)) formal = 'formal';
  else if (provider === 'hotjob' && Number(d.recruitType) === 1
    && /校招|校园招聘|应届|(?:20)?2\d届/.test([title, d.projectName, d.serviceCondition, d.workContent].join('\n'))) formal = 'formal';
  else if (targetMode==='campus'&&campusContext === false && /^(全职|正式|full.?time)$/i.test(type)) formal = 'social';

  if (provider === 'beisen') {
    if (Number(d.Status) === 1) open = 'open';
    else if (d.Status !== undefined && d.Status !== null) open = 'closed';
    Object.assign(evidence, { Category: d.Category, CategoryId: d.CategoryId, Kind: d.Kind, Status: d.Status });
  } else if (provider === 'feishu') {
    const status = d.job_post_info?.job_active_status ?? d.job_active_status;
    if (status !== undefined && status !== null) open = Number(status) === 1 ? 'open' : 'closed';
    else if (d._public_list_returned) open = 'open';
    Object.assign(evidence, { recruit_type: d.recruit_type ?? null, nested_recruitment_type: d.job_post_info?.recruitment_type ?? null, job_subject: d.job_subject,
      published_list_returned: !!d._public_list_returned, job_active_status: status ?? null });
  } else if (provider === 'hotjob') {
    const end = d.endDate && Date.parse(d.endDate.replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(d.endDate) ? '' : '+08:00'));
    if (end && Number.isFinite(end) && end < Date.now() && !d.longTermRelease) open = 'closed';
    else if (d.canDelivery === true || Number(d.showDeliverButton) === 1) open = 'open';
    // canDelivery=false in anonymous list responses alone is not a closed-job signal.
    Object.assign(evidence, { recruitType: d.recruitType, projectName: d.projectName, projectId: d.projectId,
      canDelivery: d.canDelivery, showDeliverButton: d.showDeliverButton, endDate: d.endDate });
  } else {
    if (d.status === 'open') open = 'open';
    else if (d.status !== undefined && d.status !== null && d.status !== '') open = 'closed';
    Object.assign(evidence, { commitment: d.commitment, showIsCampus: d.showIsCampus, hireMode: d.hireMode, status: d.status, projectFolder: d.projectFolder });
  }
  const combined = text([d.jobDescription, d.description, d.requirement, d.Duty, d.Require, d.workContent, d.serviceCondition].filter(Boolean).join('\n'));
  const explicitFormalConflict=combined.match(/(?:此|本)岗位\s*(?:属于|为|是)\s*(?:春招|秋招|校园招聘|校招)?\s*正式(?:校招)?岗/);
  if(formal==='internship'&&explicitFormalConflict){formal='unknown';evidence.type_conflict={structured_or_title_type:'internship',explicit_body_statement:explicitFormalConflict[0],resolution:'待核实：招聘性质字段或标题与正文明确正式岗位声明冲突'};}
  const early = combined.match(/.{0,35}(?:提前.{0,6}实习|实习.{0,10}(?:到岗|不少于|至少|个月)).{0,70}/g);
  if (formal === 'formal' && early) evidence.early_internship_requirement = early.slice(0, 4);
  const reviewed = reviewRecruitment({title,description:combined,formal_status:formal,open_status:open,recruitment_evidence:evidence,raw_metadata:{project:d.job_subject || d.projectFolder || d.projectName}},targetMode);
  return { formal_status: reviewed.formal_status, open_status: open, recruitment_evidence: reviewed.recruitment_evidence };
}

function requestBody(q) {
  if (typeof q?.body === 'object' && q.body) return { ...q.body };
  if (typeof q?.body === 'string') { try { return JSON.parse(q.body); } catch { return Object.fromEntries(new URLSearchParams(q.body)); } }
  return {};
}

function headersFor(q, entry) {
  const headers = Object.fromEntries(Object.entries(q?.headers || {}).filter(([k]) => !/^(cookie|authorization|content-length|host|eagleeye-traceid)$/i.test(k)));
  if (Object.keys(q?.headers || {}).some(k => /^eagleeye-traceid$/i.test(k))) headers['Eagleeye-Traceid'] = randomUUID();
  if (!Object.keys(headers).some(k => k.toLowerCase() === 'referer')) headers.Referer = entry;
  return headers;
}

function isJsonResponse(res) {
  if (res.record.http_status < 200 || res.record.http_status >= 300) throw new Error(`HTTP ${res.record.http_status}: ${res.url}`);
  if (!res.data || typeof res.data !== 'object') throw new Error(`Expected public JSON, received ${res.record.content_type || 'non-JSON'}: ${res.url}`);
  return res.data;
}

async function mokaPayload(res, iv) {
  let data = isJsonResponse(res);
  if (typeof data.data === 'string' && typeof data.necromancer === 'string') {
    const key = Buffer.from(data.necromancer, 'utf8'), vector = Buffer.from(iv || '', 'utf8');
    if (![16, 24, 32].includes(key.length) || vector.length !== 16) throw new Error('Moka public AES key/IV is unavailable or invalid');
    const decipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, vector);
    const decoded = Buffer.concat([decipher.update(Buffer.from(data.data, 'base64')), decipher.final()]).toString('utf8');
    data = JSON.parse(decoded);
    await saveDecoded(res.record, data);
  }
  if (data.code !== undefined && ![0, 200].includes(Number(data.code))) throw new Error(`Moka API code ${data.code}: ${data.msg || data.message || ''}`);
  return data;
}

function parseMokaInit(html) {
  for (const input of html.matchAll(/<input\b[^>]*>/gi)) {
    if (!/\bid\s*=\s*["']init-data["']/i.test(input[0])) continue;
    const value = input[0].match(/\bvalue\s*=\s*(["'])([\s\S]*?)\1/i)?.[2];
    if (value) return JSON.parse(htmlDecode(value));
  }
  throw new Error('Moka public input#init-data configuration missing');
}

function contextsFor(source) {
  const provider = source.provider;
  const examples = source.validated_api_request_examples || [];
  const pattern = provider === 'moka' ? /\/website\/jobs\/v2/ : provider === 'moka_api_platform' ? /\/api-platform\/v1\/jobs\//
    : provider === 'beisen' ? /GetJobAdPageList/i : provider === 'feishu' ? /\/search\/job\/posts/ : /\/listPosition\//;
  const contexts = new Map();
  for (const q of examples.filter(q => pattern.test(q.url))) {
    const b = requestBody(q), h = Object.fromEntries(Object.entries(q.headers || {}).map(([k,v]) => [k.toLowerCase(),v]));
    const origin = new URL(q.url).origin;
    const key = JSON.stringify([origin, new URL(q.url).pathname, b.orgId, b.siteId, b.PortalId, h['portal-channel'], h['website-path'], b.recruitment_id_list, b.recruitType]);
    if (contexts.has(key)) continue;
    let entry = h.referer || source.primary_entry_url;
    if (provider === 'moka') {
      entry = (source.public_bootstrap_requests || []).find(x => new URL(x.url).origin === origin
        && x.url.includes('/' + b.orgId + '/') && x.url.includes('/' + b.siteId))?.url || entry;
    }
    const detailPattern = provider === 'moka' ? /\/website\/job(?:\?|$)/ : provider === 'beisen' ? /GetJobAdInfo/i : provider === 'feishu' ? /\/api\/v1\/job\/posts\// : /\/listPositionDetail\//;
    const detail = examples.find(x => new URL(x.url).origin === origin && detailPattern.test(x.url)
      && (provider !== 'moka' || String(requestBody(x).siteId) === String(b.siteId)));
    const isCampus = provider === 'moka' ? /campus/.test(b.site || entry) : provider === 'moka_api_platform' ? (new URL(q.url).searchParams.has('mode')?new URL(q.url).searchParams.get('mode') === 'campus':null)
      : provider === 'beisen' ? (b.Category || []).map(String).includes('2') : provider === 'hotjob' ? Number(b.recruitType) === 1 : true;
    contexts.set(key, { key, q, body: b, entry, origin, detail, isCampus,targetMode:source.target_mode||SEARCH_MODE.id });
  }
  return [...contexts.values()];
}

function officialUrl(d, provider, context, source) {
  const id = String(d.id || d.Id || d.postId || '');
  if (!id) return { official_url: source.primary_entry_url || null, job_url_kind: source.primary_entry_url ? 'official_listing' : 'unavailable' };
  if(provider==='moka_api_platform'&&/^https?:\/\//.test(source.official_job_url_template||''))return {official_url:source.official_job_url_template.replace('{job_id}',encodeURIComponent(id)),job_url_kind:'official_detail'};
  if (provider === 'moka') return { official_url: context.entry.split('#')[0] + '#/job/' + encodeURIComponent(id), job_url_kind: 'official_detail' };
  if (provider === 'beisen') return { official_url: context.origin + (context.isCampus ? '/campus/detail' : '/social/detail') + '?jobAdId=' + encodeURIComponent(id), job_url_kind: 'official_detail' };
  if (provider === 'hotjob') {
    const tenant = context.q.url.match(/\/listPosition\/(SU[^/?]+)/)?.[1];
    return { official_url: `${context.origin}/${tenant}/pb/posDetail.html?postId=${encodeURIComponent(id)}&postType=${context.isCampus ? 'campus' : 'social'}`, job_url_kind: 'official_detail' };
  }
  if (provider === 'feishu') {
    if(/^https?:\/\//.test(source.official_job_url_template||''))return {official_url:source.official_job_url_template.replace('{job_id}',encodeURIComponent(id)),job_url_kind:'official_detail'};
    const h = Object.fromEntries(Object.entries(context.q.headers || {}).map(([k,v]) => [k.toLowerCase(),v]));
    const channel = h['website-path'] || new URL(context.entry).pathname.split('/').filter(Boolean)[0] || h['portal-channel'];
    if (channel) return { official_url: `${context.origin}/${channel}/position/${encodeURIComponent(id)}/detail`, job_url_kind: 'official_detail' };
  }
  const returned = d.applyUrl || d.apply_url || d.jobUrl;
  if (typeof returned === 'string' && /^https?:\/\//.test(returned)) return { official_url: returned, job_url_kind: 'official_detail' };
  return { official_url: source.primary_entry_url || null, job_url_kind: source.primary_entry_url ? 'official_listing' : 'unavailable' };
}

function normalize(d, provider, context, source, rawFile) {
  let body;
  if (provider === 'beisen') body = bodyParts(d.Duty, d.Require);
  else if (provider === 'hotjob') body = bodyParts(d.workContent, d.serviceCondition);
  else if (provider === 'feishu') body = bodyParts(d.description, d.requirement);
  else body = bodyParts(d.jobDescription || d.description || d.descriptionHtml, d.requirements || d.requirement);
  return { job_id: String(d.id || d.Id || d.postId || ''), company_id: source.company_id, company_name: source.display_name,
    title: d.title || d.JobAdName || d.postName || '', locations_raw: locations(d, provider), ...body,
    ...classify(d, provider, context.isCampus,context.targetMode), ...officialUrl(d, provider, context, source), raw_file: rawFile,
    raw_metadata: { department: d.department || d.Org || d.orgName, organization_id:d.OrgId, classification_two:d.ClassificationTwo, project: d.job_subject || d.projectFolder || d.projectName,
      published_at: d.publishedAt || d.publish_time || d.PostDate || d.publishDate, education: d.education || d.Degree,
      job_category: d.job_category || d.zhineng || d.postTypeName,
      location_records: d.locations || d.city_list || d.LocNames || d.workPlaceList || [] } };
}

function skipDetailsForCity(job, cities) {
  const loc=normalizeJobLocations(job);
  return jobCityStatus({cities:loc.cities,location_special:loc.special,location_unknown:loc.unknown},cities||[])==='excluded';
}

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; await fn(items[index], index); }
  }));
}

async function collectContext(source, context, options, client) {
  const provider = source.provider, pageEvidence = [], stored = new Map(), errors = [];
  let total = null, initialTotal = null, complete = false, reason = 'max_pages_reached', iv = null, totalChanged = false;
  let offset = 0, size = Math.max(1, Math.min(provider === 'moka' ? 50 : 100, Math.floor(options.pageSize || 20)));
  if (provider === 'hotjob') size = Math.min(size, Number(context.body.pageSize) || 15);
  let skipped = 0, freshCsrf = null;
  try {
    const csrfCandidates = provider === 'feishu' ? (source.public_bootstrap_requests || []).filter(q => new URL(q.url).origin === context.origin && /\/api\/v1\/csrf\/token$/.test(new URL(q.url).pathname)) : [];
    const websitePath = q => Object.entries(q.headers || {}).find(([k])=>k.toLowerCase()==='website-path')?.[1];
    const csrfBootstrap = csrfCandidates.find(q=>websitePath(q)===websitePath(context.q)) || csrfCandidates[0];
    if (csrfBootstrap) {
      const boot=await client.request({url:csrfBootstrap.url,method:'POST',headers:headersFor(csrfBootstrap,context.entry),body:requestBody(csrfBootstrap)},{purpose:'public_csrf_bootstrap'});
      const payload=isJsonResponse(boot);freshCsrf=payload.data?.token;
      if(Number(payload.code)!==0||typeof freshCsrf!=='string'||!freshCsrf)throw new Error('Public Feishu CSRF initialization did not return a token');
      if(!client.cookieValue('atsx-csrf-token',context.q.url))client.setCookie('atsx-csrf-token',freshCsrf,context.q.url,{sourceRecord:boot.record});
    }
    if (provider !== 'feishu' && provider !== 'moka_api_platform') {
      const boot = await client.request({ url: context.entry, headers: { Accept: 'text/html,application/json' } }, { purpose: 'public_configuration_bootstrap' });
      // Moka requires the public AES configuration; Beisen and Hotjob list APIs can
      // remain public even when an old landing page has moved or returns 404.
      if (boot.record.http_status !== 200 && provider === 'moka') throw new Error(`Public bootstrap HTTP ${boot.record.http_status}`);
      if (provider === 'moka') {
        const config = parseMokaInit(boot.text);
        if (/当前网页已关停|招聘站点已关闭/.test(config.message || '')) throw new Error('Public Moka recruitment portal closed: '+config.message);
        iv = config.aesIv || config.aesIV || config.data?.aesIv || config.org?.aesIv;
        context.portal_type = config.org?.type || config.mode || null;
        if (/^social$/i.test(context.portal_type || '')) context.isCampus = false;
      }
    }
    for (let page = 0; page < options.maxPages; page++) {
      let url = context.q.url, body = { ...context.body }, method = context.q.method || 'POST';
      const headers = {...headersFor(context.q, context.entry),...(freshCsrf?{'x-csrf-token':freshCsrf}:{})};
      if (provider === 'moka') body = { ...body, limit: size, offset, keyword: options.keyword || '', needStat: true };
      else if (provider === 'beisen') body = { ...body, PageIndex: page, PageSize: size, KeyWords: options.keyword || '',
        DisplayFields: [...new Set([...(body.DisplayFields||[]),'Category', 'Kind', 'LocId', 'LocNames', 'Duty', 'Require', 'Status','Org','OrgId','ClassificationTwo'])] };
      else if (provider === 'feishu') body = { ...body, limit: size, offset, keyword: options.keyword || '', recruitment_id_list: Array.isArray(context.body.recruitment_id_list) ? context.body.recruitment_id_list : ['201'] };
      else if (provider === 'moka_api_platform') {
        const u = new URL(url); u.searchParams.set('limit', String(size)); u.searchParams.set('offset', String(offset));
        url = u.href; body = null; method = 'GET';
      } else body = new URLSearchParams({ ...body, pageSize: String(size), currentPage: String(page + 1) }).toString();
      if (provider === 'hotjob' && !Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      }
      const response = await client.request({ url, method, headers, body }, { purpose: 'job_list' });
      const payload = provider === 'moka' ? await mokaPayload(response, iv) : isJsonResponse(response);
      let data, reported, explicitEnd = false;
      if (provider === 'moka') { data = payload.data?.jobs; reported = payload.data?.jobStats?.total; }
      else if (provider === 'moka_api_platform') { data = payload.jobs || payload.data?.jobs; reported = payload.total ?? payload.jobStats?.total ?? payload.data?.total; }
      else if (provider === 'beisen') {
        if (Number(payload.Code) !== 200) throw new Error(`Beisen API code ${payload.Code}: ${payload.Message || ''}`);
        data = payload.Data; reported = payload.Count;
      } else if (provider === 'feishu') {
        if (payload.code !== undefined && Number(payload.code) !== 0) throw new Error(`Feishu API code ${payload.code}: ${payload.message || ''}`);
        data = payload.data?.job_post_list; reported = payload.data?.count;
        explicitEnd = payload.data?.has_more === false;
      } else {
        if (String(payload.state) !== '200') throw new Error(`Hotjob API state ${payload.state}: ${payload.msg || ''}`);
        const form = payload.data?.pageForm; data = form?.pageData; reported = form?.dataCount ?? payload.data?.positonNum;
        if (Number(form?.pageSize) > 0) size = Number(form.pageSize);
        explicitEnd = Number(form?.totalPage) > 0 && Number(form.currentPage) >= Number(form.totalPage);
      }
      if (!Array.isArray(data)) throw new Error('Public JSON response has no supported job list');
      if (reported !== undefined && reported !== null && Number.isFinite(Number(reported))) {
        total = Number(reported);
        if (initialTotal === null) initialTotal = total; else if (total !== initialTotal) totalChanged = true;
      }
      const ids = data.map(d => String(d.id || d.Id || d.postId || ''));
      if (ids.some(id => !id)) throw new Error('Job list contains records without stable IDs');
      const previous = new Set(stored.keys()), unique = new Set(ids), newIds = [...unique].filter(id => !previous.has(id));
      const file = response.record.decoded_response_file || response.record.response_file;
      pageEvidence.push({ page: page + 1, request_index: response.record.index, response_file: file, job_ids: ids,
        new_ids: newIds.length, overlap: ids.length - newIds.length, server_total: total, explicit_end: explicitEnd });
      for (const row of data) {
        const d = provider === 'feishu' ? { ...row, _public_list_returned: true, _requested_recruitment_ids: body.recruitment_id_list } : row;
        const job = normalize(d, provider, context, source, file);
        if (!stored.has(job.job_id)) stored.set(job.job_id, { data: d, job });
      }
      if (ids.length !== unique.size) { reason = 'duplicate_ids_within_page'; break; }
      if (data.length > 0 && newIds.length === 0) { reason = 'repeated_page_no_new_ids'; break; }
      if (total !== null && stored.size === total) { complete = !totalChanged; reason = totalChanged ? 'server_total_changed_during_collection' : 'unique_ids_reconcile_server_total'; break; }
      if (!data.length || explicitEnd) {
        complete = !totalChanged && (total === null || total === stored.size);
        reason = complete ? 'explicit_end' : 'end_before_server_total_reconciled'; break;
      }
      if (total !== null && stored.size > total) { reason = 'more_unique_ids_than_server_total'; break; }
      offset += data.length;
    }
  } catch (error) { reason = error.message; errors.push(error.message); }

  const enrichable = [...stored.values()].filter(({ job }) => {
    if(options.titleFilter&&!options.titleFilter(job.title)){job.detail_skipped_reason='targeted_title_not_matched';return false;}
    if((options.targetMode||SEARCH_MODE.id)!=='campus'&&knownOtherType(job,options.targetMode||SEARCH_MODE.id)){job.detail_skipped_reason='explicit_non_target_type';return false;}
    if (skipDetailsForCity(job, options.cities)) { job.detail_skipped_reason = 'explicit_non_target_city'; skipped++; return false; }
    return !job.locations_raw.length || job.formal_status === 'unknown' || job.open_status === 'unknown'
      || (options.mode === 'full' && !job.body_complete);
  });
  const detailTargets=options.maxDetails==null?enrichable:enrichable.slice(0,Math.max(0,options.maxDetails));
  if (provider!=='moka_api_platform' && (provider!=='feishu'||context.detail)) await mapLimit(detailTargets, 3, async item => {
    const job = item.job;
    try {
      let q = context.detail, url, body, method, headers;
      if (provider === 'moka') {
        url = q?.url || context.origin + '/api/outer/ats-apply/website/job';
        body = { orgId: context.body.orgId, siteId: context.body.siteId, jobId: job.job_id, locale: context.body.locale || 'zh-CN' }; method = 'POST';
      } else if (provider === 'beisen') {
        const u = new URL(q?.url || context.origin + '/api/JobAd/GetJobAdInfo');
        u.searchParams.set('_timestamp', String(Date.now())); u.searchParams.set('jobAdId', job.job_id);
        u.searchParams.set('category', String(item.data.CategoryId || (context.isCampus ? 2 : 1)));
        u.searchParams.set('displayFields', JSON.stringify(['jobAdName','Duty','Require','Category','Kind','LocId','LocNames','Status','PostDate']));
        url = u.href; method = 'GET'; body = null;
      } else if(provider==='feishu') {
        url=context.origin+'/api/v1/job/posts/'+encodeURIComponent(job.job_id);method='GET';body=null;
      } else {
        url = q?.url || context.q.url.replace('/listPosition/', '/listPositionDetail/'); method = 'POST';
        body = new URLSearchParams({ postId: job.job_id, recruitType: String(item.data.recruitType ?? context.body.recruitType ?? 1) }).toString();
      }
      headers = {...headersFor(q || context.q, context.entry),...(freshCsrf?{'x-csrf-token':freshCsrf}:{})};
      const response = await client.request({ url, method, body, headers }, { purpose: 'job_detail' });
      const payload = provider === 'moka' ? await mokaPayload(response, iv) : isJsonResponse(response);
      if (provider === 'hotjob' && String(payload.state) === '1017') { job.open_status = 'closed'; job.recruitment_evidence.closed_api_state = '1017'; return; }
      if (provider === 'beisen' && Number(payload.Code) !== 200) throw new Error(`Beisen detail code ${payload.Code}`);
      if (provider === 'hotjob' && String(payload.state) !== '200') throw new Error(`Hotjob detail state ${payload.state}`);
      if (provider === 'feishu' && Number(payload.code)!==0) throw new Error(`Feishu detail code ${payload.code}`);
      const detail = provider === 'beisen' ? payload.Data : provider==='feishu' ? payload.data?.job_post_detail : payload.data;
      if (!detail || typeof detail !== 'object') throw new Error('Detail JSON is missing its job object');
      const detailId = String(detail.id || detail.Id || detail.postId || '');
      if (detailId !== job.job_id) throw new Error('Detail JSON job ID differs from requested list job');
      item.data = { ...item.data, ...detail };
      item.job = normalize(item.data, provider, context, source, response.record.decoded_response_file || response.record.response_file);
    } catch (error) { job.detail_error = error.message; errors.push(`${job.job_id}: ${error.message}`); }
  });
  const jobs = [...stored.values()].map(item => item.job);
  if(provider==='feishu'&&options.targetMode==='social'&&total>=10000){complete=false;reason+='; reported_total_at_10000_ceiling_full_coverage_unconfirmed';}
  const requiredIncomplete = options.mode === 'full' ? jobs.filter(j => !j.detail_skipped_reason && j.formal_status === searchMode(options.targetMode||SEARCH_MODE.id).status && j.open_status === 'open' && !j.body_complete).length : 0;
  if (requiredIncomplete) errors.push(`${requiredIncomplete} formal open jobs still lack complete JD bodies`);
  return { jobs, coverage: { status: complete && !errors.length ? 'complete' : jobs.length || pageEvidence.length ? 'partial' : 'failed',
    pages: pageEvidence.length, server_total: total, jobs_observed: jobs.length, reason: errors.length ? [reason, ...errors].join('; ') : reason,
    page_evidence: pageEvidence, list_complete: complete, detail_skipped_city: skipped, details_failed: errors.length, entry_url: context.entry } };
}

/** Public ATS collection. Evidence is written only to the requested output directory. */
export async function collectCommon(source, options = {}) {
  if (!supported.has(source.provider)) return null;
  source={...source,target_mode:options.targetMode||source.target_mode||SEARCH_MODE.id};
  const settings = { mode: 'list', maxPages: 1000, pageSize: 20, timeoutMs: 20000, ...options };
  if (!['list', 'full'].includes(settings.mode)) throw new Error('mode must be list or full');
  if (!Number.isInteger(settings.maxPages) || settings.maxPages < 1) throw new Error('maxPages must be a positive integer');
  const client = createClient(settings), checked = new Date().toISOString(), contexts = contextsFor(source), reports = [], jobs = new Map();
  for (const context of contexts) {
    const result = await collectContext(source, context, settings, client);
    reports.push(result.coverage);
    for (const job of result.jobs) {
      const previous = jobs.get(job.job_id);
      if (!previous || (!previous.body_complete && job.body_complete)) jobs.set(job.job_id, job);
    }
  }
  const complete = reports.length > 0 && reports.every(r => r.status === 'complete');
  return { company_id: source.company_id, display_name: source.display_name, checked_at: checked, jobs: [...jobs.values()], requests: client.records,
    coverage: { status: complete ? 'complete' : jobs.size || reports.some(r => r.pages > 0) ? 'partial' : 'failed',
      pages: reports.reduce((n,r) => n + r.pages, 0), server_total: reports.length === 1 ? reports[0].server_total : null,
      jobs_observed: jobs.size, reason: contexts.length ? reports.map(r => r.reason).join('; ') : 'No validated API list template for this provider',
      contexts: reports, page_evidence: reports.flatMap(r => r.page_evidence) } };
}
