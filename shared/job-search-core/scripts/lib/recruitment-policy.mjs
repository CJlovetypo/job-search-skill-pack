// Admission metadata only. This does not rate ability, interest, or graduate eligibility.
import {SEARCH_MODE,searchMode} from './search-mode.mjs';
import {bodyPendingReason} from './body-fetch.mjs';
export const RECRUITMENT_POLICY_VERSION = '2026-09-18-campus-evidence';
const yes = value => value === true || value === 1 || value === '1' || value === 'true';
const label = value => typeof value === 'string' ? value : value?.name?.zh_cn || value?.name?.i18n || value?.label || value?.name || '';
const campusLabel = value => /校招|校园(?:人才)?招聘|应届|fresh\s*graduate|university\s*(?:recruit|hiring|graduate)|graduate\s*(?:recruit|program|scheme)|campus\s*(?:recruit|hiring)/i.test(label(value));

// Restore old per-job omissions only from the exact successful response request.
export function restoreRequestRecruitmentEvidence(job,requests=[]) {
  const normalized=value=>String(value||'').replaceAll('\\','/').toLowerCase();
  if(!job.raw_file)return job;
  const matching=requests.filter(r=>r.response_file&&normalized(r.response_file)===normalized(job.raw_file)&&r.http_status>=200&&r.http_status<300);
  if(matching.length!==1)return job;
  const request=matching[0],e=job.recruitment_evidence||{};
  let body=request.body;if(typeof body==='string'){try{body=JSON.parse(body);}catch{return job;}}
  if(e.provider!=='feishu'||!/\/api\/v1\/search\/job\/posts(?:[/?]|$)/.test(request.url||'')||!Array.isArray(body?.recruitment_id_list))return job;
  return {...job,recruitment_evidence:{...e,query_recruitment_id_list:body.recruitment_id_list,query_evidence:{request_url:request.url,response_file:request.response_file,response_sha256:request.response_sha256,checked_at:request.checked_at,field:'body.recruitment_id_list',value:body.recruitment_id_list}}};
}

export function campusEvidence(job) {
  const e = job.recruitment_evidence || {}, m = job.raw_metadata || {}, found = [];
  const add = (field, value) => found.push({field, value});
  for (const key of ['Category', 'recruitLabelName', 'projectType', 'job_type_descr', 'recruitmentType', 'batchTypeDesc', 'batchName', 'planName']) {
    if (campusLabel(e[key])) add('recruitment_evidence.' + key, e[key]);
  }
  for (const [field, value] of [['recruit_type',e.recruit_type],['nested_recruitment_type',e.nested_recruitment_type]]) {
    if (campusLabel(value) || campusLabel(value?.parent) || String(value?.id) === '201') add('recruitment_evidence.'+field,value);
  }
  for (const [field, value] of [['projectFolder',e.projectFolder],['job_subject',e.job_subject],['projectName',e.projectName],['public_project',e.public_project],['project',m.project]]) {
    const names = [label(value),value?.project_type,value?.planName,value?.projectName];
    if (names.some(campusLabel)) add(field.startsWith('project') && field === 'project' ? 'raw_metadata.project' : 'recruitment_evidence.'+field,value);
  }
  if (yes(e.university_job)) add('recruitment_evidence.university_job',e.university_job);
  if (e.provider==='amazon_jobs'&&e.primary_search_label==='studentprograms.team-jobs-for-grads') add('recruitment_evidence.primary_search_label',e.primary_search_label);
  if (yes(e.showIsCampus)&&!(['moka','moka_api_platform'].includes(e.provider)&&Number(e.hireMode)===1)) add('recruitment_evidence.showIsCampus',e.showIsCampus);
  if (['moka','moka_api_platform'].includes(e.provider) && Number(e.hireMode) === 2) add('recruitment_evidence.hireMode',e.hireMode);
  if (e.provider === 'hotjob' && Number(e.recruitType) === 1) add('recruitment_evidence.recruitType',e.recruitType);
  if (e.query_recruitType === 'GRADUATE') add('recruitment_evidence.query_recruitType',e.query_recruitType);
  if (e.query_recruitment_id_list?.length === 1 && String(e.query_recruitment_id_list[0]) === '201') add('recruitment_evidence.query_recruitment_id_list',e.query_recruitment_id_list);
  // A campus landing-page URL on its own is not a returned job/project label.
  return found;
}

function directionEvidence(job) {
 const e=job.recruitment_evidence||{},m=job.raw_metadata||{},provider=e.provider||job.provider;
 const title=String(job.title||'').replace(/(?:需|可|要求|接受)?提前实习/g,'').replace(/实习(?:经历|经验).{0,4}(?:优先|加分)/g,'');
 const labels=['Category','CategoryName','KindLabel','commitment','Kind','hireTypeDesc','job_type_text','job_type_descr','job_class','recruitTypeName','recruitmentType','jobNature','hireTypeName','projectName','objectName','type','career_status','positionSourceType','timeType','typeOfEmployment','experienceLevel'];
 const text=labels.map(k=>label(e[k])||label(m[k])).filter(Boolean).map(x=>String(x).replace(/(?:需|可|要求|接受)?提前实习/g,'').replace(/实习(?:经历|经验).{0,4}(?:优先|加分)/g,'')).join(' ');
 const rt=e.recruit_type||e.nested_recruitment_type,rtLabel=[label(rt),label(rt?.parent)].join(' ');
 const use=(status,field,value)=>({status,evidence:[{field,value}]});
 if(/校园大使|夏令营|训练营|博士后|postdoctoral|postdoc\b/i.test(title))return use('activity','title',job.title);
 if(/实习|\bintern(?:ship)?\b|working student|co[ -]?op/i.test(text+' '+rtLabel)
   || /^实习|实习(?:生|转正|工程师|开发|算法|设计|产品|岗位|岗|助理)|转正实习|(?:^|[-—_/（(【［\[\s])实习(?:[-—_/）)】］\]\s]|$)|\bintern(?:ship)?\b|working student|co[ -]?op/i.test(title))return use('internship','returned_type_or_title',{text,rt,title:job.title});
 if(['beisen','beisen_lightbolt'].includes(provider)&&Number(e.CategoryId)===3)return use('internship','CategoryId',e.CategoryId);
 if(provider==='feishu'&&String(rt?.id)==='202')return use('internship','recruit_type',rt);
 if(provider==='hotjob'&&Number(e.recruitType)===12)return use('internship','recruitType',e.recruitType);
 // Explicit job/project campus evidence takes precedence over full-time schedule or work years.
 if(campusEvidence(job).length)return null;
 if(/兼职|part[ -]?time/i.test(text))return use('parttime','returned_type',text);
 if(/社会招聘|社招|experienced(?: professional)?(?: hire| recruit)?/i.test(text+' '+rtLabel))return use('social','returned_type',{text,rt});
 if(['beisen','beisen_lightbolt'].includes(provider)&&Number(e.CategoryId)===1)return use('social','CategoryId',e.CategoryId);
 if(provider==='feishu'&&(String(rt?.id)==='101'||String(rt?.parent?.id)==='1'))return use('social','recruit_type',rt);
 if(provider==='hotjob'&&Number(e.recruitType)===2)return use('social','recruitType',e.recruitType);
 if(['moka','moka_api_platform'].includes(provider)&&Number(e.hireMode)===1&&/全职|正式|full.?time/i.test(text))return use('social','hireMode_and_commitment',{hireMode:e.hireMode,commitment:e.commitment});
 const years=String(m.workingExpName||m.workyearname||e.graduate||e.YearsofWorkingLabel||'');
 if(['51job_coapi','zhaopin_grace','beisen_lightbolt'].includes(provider)&&/^[1-9]\d*(?:\s*[-~至]\s*\d+)?\s*年/.test(years))return use('social','returned_required_experience',years);
 if(/全职|full[ -]?time/i.test(text)&&job.formal_status!=='formal') {
  const mandatory=String(job.requirements||'').split(/[\n。；;]/).filter(x=>!/(?:实习|应届|校招|优先|最好|加分|可接受|prefer|intern|graduate)/i.test(x));
  const experience=mandatory.find(x=>/(?:[1-9]\d*\s*(?:[-~至]\s*\d+)?\s*年(?:以上)?[^。\n]{0,12}工作经验|(?:at least\s*)?[1-9]\d*\+?\s*(?:to\s*\d+\s*)?years?\s+(?:of\s+)?(?:relevant\s+|professional\s+|work\s+|industry\s+)?experience)/i.test(x));
  if(experience)return use('social','explicit_professional_experience_requirement',experience);
 }
 // No blanket rule turns an unlabeled full-time posting into experienced hiring.
 if(/(?:^|[-—_/（(【［\[\s])社招|社会招聘/.test(title))return use('social','title',job.title);
 return null;
}

export function reviewRecruitment(job,targetMode=SEARCH_MODE.id) {
  const e = job.recruitment_evidence || {};
  if(targetMode!=='campus'&&!e.type_conflict&&!(e.conflicting_recruitment_types?.length>1)) {
    const found=directionEvidence(job);
    if(found)return {...job,formal_status:found.status,recruitment_evidence:{...e,admission_review:{policy_version:'2026-09-19-direction-evidence',status:found.status,reason:'依据岗位返回的招聘类型或明确职位标识确认；工作时间安排与招聘身份分别判断',evidence:found.evidence}}};
  }
  const evidence = campusEvidence(job);
  const title = String(job.title || '');
  const types = [e.commitment,e.Kind,e.hireTypeDesc,e.job_type_text,e.job_schedule_type,...(Array.isArray(e.employment_type)?e.employment_type:[])].filter(Boolean).join(' ');
  let status = job.formal_status || 'unknown', reason = '', basis = [];
  if (e.type_conflict || e.conflicting_recruitment_types?.length > 1) {
    status = 'unknown'; reason = '招聘类型与正文或不同接口之间有明确冲突，需确认实际录用安排'; basis = [e.type_conflict || e.conflicting_recruitment_types];
  } else if (/校园大使|夏令营|训练营|博士后|postdoctoral|postdoc\b/i.test(title)) {
    status = 'activity'; reason = '该条目为校园活动、人才培养项目或博士后招募，不纳入普通正式校招岗位'; basis = [{field:'title',value:title}];
  } else if (/兼职|part[ -]?time/i.test(types) || /(?:^|[-（(\s])兼职|兼职.*(?:教师|助理)/.test(title)) {
    status = 'parttime'; reason = '明确为兼职岗位，不纳入本次正式校招'; basis = [{field:'employment_type',value:types||title}];
  } else if (/(?:^|[\s【\[（(\-—])(?:社招|社会招聘)(?=$|[\s】\]）)\-—:：])/i.test(title)) {
    status = evidence.length || status === 'formal' ? 'unknown' : 'social';
    reason = status === 'unknown' ? '岗位标题明确标注社招，与校招类型或频道证据冲突，需核实；不纳入正式校招' : '岗位标题明确标注社会招聘';
    basis = [{field:'title',value:title},...evidence];
  } else if (['internship','social'].includes(status)) {
    return job;
  } else if (/实习|\bintern(?:ship)?\b/i.test(types)) {
    status = 'internship'; reason = '接口用工类型明确为实习'; basis = [{field:'employment_type',value:types}];
  } else if (evidence.length) {
    status = 'formal'; reason = '接口明确标注校招或岗位关联校招项目，按用户规则确认；不再要求另填全职/正式字段'; basis = evidence;
  } else if (status === 'formal') {
    return job;
  } else {
    reason = targetMode==='campus'?'尚未找到该岗位的校招类型标签或校招项目关联证据；仅全职、公司校招入口或初级岗位名称不足以确认':'尚未找到该岗位的明确目标招聘类型证据；仅全职、门户名称或普通岗位名称不足以确认';
  }
  return {...job,formal_status:status,recruitment_evidence:{...e,admission_review:{policy_version:RECRUITMENT_POLICY_VERSION,status,reason,evidence:basis}}};
}

export function verificationIssues(job,targetMode=SEARCH_MODE.id) {
  const result = [];
  if (job.formal_status !== searchMode(targetMode).status) result.push({code:'recruitment',reason:job.recruitment_evidence?.admission_review?.reason || '该岗位的'+searchMode(targetMode).label+'性质尚未确认'});
  if (job.open_status !== 'open') result.push({code:'open_status',reason:'当前开放投递状态尚未确认'});
  if (job.city_status === 'unknown') result.push({code:'location',reason:'接口地点、岗位标题及正文均未确认具体工作城市或明确的全国/远程安排'});
  if (!job.body_complete) result.push({code:'body',reason:bodyPendingReason(job)});
  return result;
}
