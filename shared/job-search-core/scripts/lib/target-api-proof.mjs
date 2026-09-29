import {campusEvidence} from './recruitment-policy.mjs';
/** Strict target-JD admission. Never use inferred formal_status as proof. */
export function reconcileTargetJob(job,source,mode){
  if(job.body_complete!==true||job.open_status!=='open'||['activity','parttime'].includes(job.formal_status))return job;
  const proofs=['campus','social','internship'].map(direction=>({direction,proof:targetApiProof(job,source,direction)}));
  const accepted=proofs.filter(p=>p.proof.accepted),selected=accepted.length===1?accepted[0]:null;
  const proof=selected?.proof||{accepted:false,reason:accepted.length?'conflicting_direction_proofs':'no_confirmed_recruitment_type',evidence:[]};
  return {...job,formal_status:selected?(selected.direction==='campus'?'formal':selected.direction):'unknown',recruitment_evidence:{...job.recruitment_evidence,target_api_admission:proof}};
}
export function targetApiProof(job={},source={},mode) {
  const e=job.recruitment_evidence||{},m=job.raw_metadata||{},evidence=[];
  const reject=reason=>({accepted:false,reason,evidence});
  const add=(field,value,kind)=>evidence.push({field,value,kind});
  if(!['campus','internship','social'].includes(mode))return reject('unsupported_target_mode');
  if(job.company_id&&source.company_id&&String(job.company_id)!==String(source.company_id))return reject('company_binding_conflict');
  if(e.ownership_mismatch||e.tenant_mismatch||m.ownership_mismatch||m.tenant_mismatch||source.ownership_mismatch)return reject('explicit_tenant_conflict');
  const body=source.validated_api_request_examples?.find(q=>q.body&&typeof q.body==='object')?.body||{};
  for(const [field,actual,expected] of [
    ['orgId',m.orgId??e.orgId,body.orgId],['ctmid',m.ctmid,source.api_config?.ctmid],
    ['ehireCtmId',m.ehireCtmId,source.api_config?.ehire_ctm_id],
    ['TenantId',m.TenantId,source.api_config?.tenant_id],
  ])if(actual!=null&&expected!=null&&String(actual)!==String(expected)){add(field,{actual,expected},'identity_conflict');return reject('response_tenant_conflict');}
  add('source_binding',{source_id:source.source_id||null,company_id:source.company_id||null,basis:'Inherited previously verified employer/tenant binding; assigned normalized company_id is not independent ownership evidence. No new independent ownership claim.'},'identity_scope');
  if(job.open_status!=='open')return reject('current_open_status_not_confirmed');
  const plain=value=>String(value??'').replace(/<\/(?:p|div|li|h[1-6])>|<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').trim();
  const description=plain(job.description),requirements=plain(job.requirements);
  if(job.body_complete!==true||description.length+requirements.length<35)return reject('complete_current_jd_body_not_confirmed');
  const jobId=String(job.source_job_id??job.job_id??'').trim();
  const urls=[job.official_url,job.jd_url,job.api_url].filter(x=>typeof x==='string'&&/^https?:\/\//i.test(x));
  if(!urls.length)return reject('jd_link_unavailable');
  const listing=job.job_url_kind==='official_listing';
  if(listing&&!jobId)return reject('listing_link_missing_job_id');
  add('jd_link',{url:urls[0],job_id:jobId||null,link_kind:listing?'listing_with_id':job.job_url_kind||'provided_job_url',basis:listing?'Full API JD plus stable job ID; website only offers a listing entry.':'HTTP(S) job link supplied by the collector.'},'link');
  if(e.type_conflict||e.conflicting_recruitment_types?.length>1)return reject('explicit_recruitment_type_conflict');

  const label=value=>typeof value==='string'?value:typeof value?.name==='string'?value.name:value?.name?.zh_cn||value?.name?.i18n||value?.label||'';
  const clean=value=>label(value).replace(/(?:需|可|要求|接受|支持|允许|必须)?提前.{0,3}实习/g,'').replace(/实习(?:经历|经验).{0,4}(?:优先|加分|不要求)/g,'').trim();
  const title=clean(job.title||'');
  if(/校园大使|夏令营|训练营|博士后|postdoctoral|postdoc\b/i.test(title))return reject('activity_or_postdoc_not_target_job');
  const internTitle=value=>{
    const text=clean(value);
    if(/非实习|不是实习|不属于实习|不招实习/.test(text))return false;
    return /^实习|实习(?:生|转正|工程师|开发|算法|设计|产品|岗位|岗|助理|招聘)|转正实习|日常实习|暑期实习|应届实习|(?:^|[-—_/（(【［\[\s])实习(?:[-—_/）)】］\]\s]|$)|\bintern(?:ship)?\b|\bworking student\b|\bco[ -]?op\b/i.test(text);
  };
  const internLabel=value=>/^(?:实习(?:生)?(?:招聘|岗位)?|日常实习|暑期实习|转正实习|intern(?:ship)?|working student|co[ -]?op)$/i.test(clean(value));
  const socialLabel=value=>/^(?:社会招聘|社招|社会人才招聘|experienced(?:\s+(?:hiring|professionals?|recruitment))?|experienced hire)$/i.test(clean(value));
  const campusLabel=value=>/校招|校园(?:人才)?招聘|应届|20\d{2}届.{0,8}(?:秋招|春招)|\bfresh graduates?\b|\bnew (?:college )?grad\b|\bcampus (?:recruit|hiring)|\bgraduate (?:program|scheme|recruit|trainee|engineer)/i.test(clean(value));
  const internship=[],social=[],campus=[],explicitFormal=[];
  const push=(array,field,value)=>array.push({field,value});
  const srcProvider=e.provider||job.provider||source.provider||'';
  let provider=srcProvider;
  const entry=String(source.primary_entry_url||'');
  if(provider==='first_party'&&/careers\.shein\.cn/.test(entry))provider='shein';
  if(provider==='first_party'&&/careers\.ctrip\.com/.test(entry))provider='ctrip';
  if(provider==='openout')provider='mihoyo';
  if(internTitle(title))push(internship,'title',job.title);
  if(/(?:^|[-—_/（(【［\[\s])社招(?:[-—_/）)】］\]\s]|$)|社会招聘/.test(title))push(social,'title',job.title);
  if(campusLabel(title))push(campus,'title',job.title);
  // Only type fields carry direct type semantics; eligibility objectName is not one.
  for(const key of ['Category','CategoryName','KindLabel','commitment','Kind','hireTypeDesc','job_type_text','job_type_descr','job_class','recruitTypeName','recruitmentType','jobNature','hireTypeName','type','job_schedule_type','plan_type','timeType','workerType','typeOfEmployment','experienceLevel']) {
    const value=e[key]??m[key];
    if(internLabel(value))push(internship,'returned.'+key,value);
    if(socialLabel(value))push(social,'returned.'+key,value);
    if(campusLabel(value))push(campus,'returned.'+key,value);
  }
  for(const value of Array.isArray(e.employment_type)?e.employment_type:[e.employment_type]){
    if(internLabel(value))push(internship,'returned.employment_type',value);
    if(socialLabel(value))push(social,'returned.employment_type',value);
    if(campusLabel(value))push(campus,'returned.employment_type',value);
  }
  if(internLabel(m.work_nature))push(internship,'raw_metadata.work_nature',m.work_nature);
  for(const [key,value]of [['projectName',e.projectName],['projectFolder',e.projectFolder],['job_subject',e.job_subject],['planName',e.planName],['plan_name',e.plan_name],['project',m.project]]) {
    if(internTitle(label(value)))push(internship,'returned_project.'+key,label(value));
    if(socialLabel(label(value)))push(social,'returned_project.'+key,label(value));
    if(campusLabel(label(value)))push(campus,'returned_project.'+key,label(value));
  }
  const rt=e.recruit_type||e.nested_recruitment_type;
  if(rt){if(internLabel(rt))push(internship,'recruit_type',rt);if(socialLabel(rt)||socialLabel(rt.parent))push(social,'recruit_type',rt);if(campusLabel(rt)||campusLabel(rt.parent))push(campus,'recruit_type',rt);}
  // Scope numeric enums to the actual provider. Kind=2 alone is deliberately absent.
  if(['beisen','beisen_lightbolt'].includes(provider)){
    if(Number(e.CategoryId)===3)push(internship,'CategoryId',e.CategoryId);
    if(Number(e.CategoryId)===1)push(social,'CategoryId',e.CategoryId);
    if(Number(e.CategoryId)===2)push(campus,'CategoryId',e.CategoryId);
  }
  if(['feishu','bytedance','iqiyi'].includes(provider)){
    if(String(rt?.id)==='202')push(internship,'recruit_type.id',rt);
    if(String(rt?.id)==='101'||String(rt?.parent?.id)==='1')push(social,'recruit_type.id',rt);
    if(String(rt?.id)==='201')push(explicitFormal,'recruit_type.id',rt);
  }
  if(provider==='hotjob'){
    if(Number(e.recruitType)===2)push(social,'recruitType',e.recruitType);
    // Official mc/index.js: intern <-> 12, label 实习生招聘. The response must
    // actually return 12; merely requesting this filter is never evidence.
    if(Number(e.recruitType)===12)push(internship,'recruitType',e.recruitType);
    // Type 1 is a campus channel containing internships too; never label 3 internship.
    if(Number(e.recruitType)===1)push(campus,'recruitType',e.recruitType);
  }
  if(['moka','moka_api_platform'].includes(provider)){
    if(Number(e.hireMode)===1)push(social,'hireMode',e.hireMode);
    if(Number(e.hireMode)===2)push(campus,'hireMode',e.hireMode);
    // showIsCampus=true also occurs in independently verified social Moka JDs.
  }
  if(provider==='meituan'){
    if(String(e.jobType)==='2')push(internship,'jobType',e.jobType);
    if(String(e.jobType)==='3')push(social,'jobType',e.jobType);
    if(String(e.jobType)==='1')push(explicitFormal,'jobType',e.jobType);
  }
  if(provider==='shein'){
    if(e.jobTypeId==='PRACTICE')push(internship,'jobTypeId',e.jobTypeId);
    if(e.jobTypeId==='SOCIAL')push(social,'jobTypeId',e.jobTypeId);
    if(e.jobTypeId==='CAMPUS')push(campus,'jobTypeId',e.jobTypeId);
  }
  if(provider==='ctrip'){
    // Numeric kind=3 was observed with explicit internship title; retain corroboration.
    if(String(e.kind)==='3'&&internship.length)push(internship,'kind',e.kind);
    if(String(e.category)==='1'&&String(e.kind)==='1')push(social,'category_and_kind',{category:e.category,kind:e.kind});
    if(String(e.category)==='2')push(campus,'category',e.category);
  }
  if(provider==='mihoyo'){
    if(Number(e.hireType)===0&&e.hireType!=null)push(social,'hireType',e.hireType);
    if(Number(e.hireType)===1)push(campus,'hireType',e.hireType);
  }
  if(provider==='cec_campus'){
    if(Number(e.position_type)===1)push(social,'position_type',e.position_type);
    if(Number(e.position_type)===0&&e.position_type!=null)push(campus,'position_type',e.position_type);
  }
  if(provider==='ccb_public'){
    if(e.plan_type==='SX')push(internship,'plan_type',e.plan_type);
    if(e.plan_type==='XY')push(explicitFormal,'plan_type',e.plan_type);
  }
  if(provider==='xiaohongshu'&&e.recruitType==='intern_recruit')push(internship,'recruitType',e.recruitType);
  if(provider==='xiaohongshu'&&e.recruitType==='club_recruit')push(social,'recruitType',e.recruitType);
  if(provider==='kuaishou'){
    if(e.positionNatureCode==='C002')push(internship,'positionNatureCode',e.positionNatureCode);
    if(e.positionNatureCode==='C001'&&e.recruitProjectCode==='socialr')push(social,'positionNatureCode_and_project',{nature:e.positionNatureCode,project:e.recruitProjectCode});
  }
  if(provider==='bilibili'){
    if(e.positionTypeName==='实习')push(internship,'positionTypeName',e.positionTypeName);
    if(e.positionTypeName==='全职'&&e.recruitType===0&&e.api_endpoint==='https://jobs.bilibili.com/api/srs/position/positionList')push(social,'srs_returned_type',{positionTypeName:e.positionTypeName,recruitType:e.recruitType,endpoint:e.api_endpoint});
  }
  if(provider==='jd'&&String(e.public_project?.id)===String(e.planId)&&internTitle(e.public_project?.planName))push(internship,'returned_plan_binding',e.public_project);
  if(provider==='alibaba'&&internTitle(e.batchName))push(internship,'batchName',e.batchName);
  if(provider==='tencent'&&/^https:\/\/careers\.tencent\.com\/tencentcareer\/api\/post\/Query(?:\?|$)/.test(e.api_endpoint||'')&&/^(?:[一二两三四五六七八九十]+|[1-9]\d?)(?:至(?:[一二两三四五六七八九十]+|\d+))?年(?:以上)?工作经验$/.test(e.RequireWorkYearsName||''))push(social,'official_experienced_work_years',{endpoint:e.api_endpoint,RequireWorkYearsName:e.RequireWorkYearsName});
  if(/(?:本|此)岗位\s*(?:属于|为|是)\s*(?:春招|秋招|校园招聘|校招)?\s*正式(?:校招)?岗/.test(description+'\n'+requirements))push(explicitFormal,'explicit_formal_statement',(description+'\n'+requirements).match(/.{0,10}(?:本|此)岗位.{0,50}/)?.[0]);

  if(internship.length&&explicitFormal.length){add('conflicting_actual_types',{internship,explicitFormal},'conflict');return reject('internship_conflicts_with_explicit_formal_job_type');}
  if(mode==='campus'){
    if(internship.length)return reject('explicit_internship_not_campus');
    if(social.length)return reject('explicit_social_not_campus');
    const actual=[...campus,...explicitFormal,...campusEvidence(job)];
    if(!actual.length)return reject('no_explicit_returned_campus_type_or_project');
    actual.forEach(x=>add(x.field,x.value,'campus_type'));
    return {accepted:true,reason:'explicit_current_complete_campus_jd',evidence};
  }
  if(mode==='internship'){
    if(!internship.length)return reject('no_explicit_returned_internship_type_or_title');
    internship.forEach(x=>add(x.field,x.value,'internship_type'));
    return {accepted:true,reason:'explicit_current_complete_internship_jd',evidence};
  }
  if(internship.length){add('internship_evidence',internship,'other_direction');return reject('explicit_internship_not_social');}
  if(campus.length||explicitFormal.length){add('campus_evidence',[...campus,...explicitFormal],'other_direction');return reject(social.length?'social_conflicts_with_actual_campus_identity':'campus_not_social');}
  if(social.length){social.forEach(x=>add(x.field,x.value,'social_type'));return {accepted:true,reason:'explicit_current_complete_social_jd',evidence};}

  const experienceFields=['workingExpName','workyearname','YearsofWorkingLabel','workYear','working_life','workingYears','experience_years'];
  const yearPattern=/(?:^|\D)([1-9]\d?)(?:\s*[-~–至]\s*\d+)?\s*(?:\+|以上)?\s*(?:年|years?)/i;
  const structured=experienceFields.map(k=>({field:k,value:m[k]??e[k]})).find(x=>{
    const value=String(x.value??''),match=value.match(yearPattern);
    return match&&Number(match[1])<=40&&!/不限|应届|在校|可接受|优先|preferred|intern|graduate/i.test(value);
  });
  // Preserve preferred-section boundaries so a numeric bullet below that heading
  // cannot accidentally become a mandatory requirement.
  let preferredSection=false;
  const clauses=requirements.split(/[\n。；;]/).filter(x=>{
    if(/^\s*(?:preferred|desired|nice.to.have|优先条件|加分项)/i.test(x)){preferredSection=true;return false;}
    if(/^\s*(?:required|minimum|basic|mandatory|任职要求|基本要求|必备条件)/i.test(x))preferredSection=false;
    return !preferredSection&&!/(?:实习|应届|校招|优先|最好|加分|可接受|可放宽|prefer|desired|nice.to.have|intern|graduate)/i.test(x);
  });
  const requiredExperience=clauses.find(x=>{
    if(/(?:无需|不要求|不限|不需).{0,8}(?:经验|经历)|(?:no|without).{0,12}experience|0\s*(?:[-~–至]|to)\s*\d+\s*(?:年|years?)/i.test(x))return false;
    return /(?<![\d.\-~–至])(?:[1-9]\d?\s*(?:[-~–至]\s*\d+)?\s*(?:\+|以上)?\s*年[^。\n]{0,30}(?:工作经验|工作经历|经验)|(?:at least\s*|minimum(?: of)?\s*)?[1-9]\d?\+?\s*(?:[-–]|to)?\s*\d*\s*years?['’]?\s+(?:of\s+)?(?:(?:relevant|professional|work|working|industry|related)\s+){0,3}experience)/i.test(x);
  });
  if(structured&&requiredExperience){add('structured_required_experience',structured,'experience');add('jd_required_experience',requiredExperience.trim(),'experience');return {accepted:true,reason:'structured_experience_corroborated_by_mandatory_jd_requirement',evidence};}
  const fullTimeFields=['commitment','KindLabel','Kind','jobNature','job_type_text','job_type_descr','job_schedule_type','timeType','workerType','typeOfEmployment','work_nature','employment_type'];
  const fullTime=fullTimeFields.flatMap(field=>{
    const value=e[field]??m[field];return (Array.isArray(value)?value:[value]).map(value=>({field,value}));
  }).find(x=>/^(?:全职|全日制|正式工作|正式员工|full[ -]?time)$/i.test(label(x.value).trim()));
  if(fullTime&&requiredExperience){add('returned_full_time',fullTime,'work_schedule');add('jd_required_experience',requiredExperience.trim(),'experience');return {accepted:true,reason:'returned_full_time_with_mandatory_nonintern_experience',evidence};}
  const verifiedSocialEndpoint=provider==='alibaba'&&e.api_endpoint==='https://talent.alibaba.com/position/search'
    ||provider==='jd'&&e.api_endpoint==='https://zhaopin.jd.com/web/job/job_list'
    ||provider==='baidu'&&e.api_endpoint==='https://talent.baidu.com/httservice/getPostListNew'&&e.query_recruit_type==='SOCIAL'
    ||provider==='icims_jibe'&&e.published_list_returned===true&&/^full[ -]?time$/i.test(e.commitment||'');
  const professionalClause=requiredExperience||e.required_experience||clauses.find(x=>/(?:具备|具有|拥有|有)[^。\n]{0,50}(?:全局操盘经验|业务拓展能力建设经验|互联网行业经验)/.test(x));
  if(verifiedSocialEndpoint&&professionalClause){add('verified_social_api',{endpoint:e.api_endpoint,query_recruit_type:e.query_recruit_type},'channel_corroboration');add('jd_mandatory_professional_experience',professionalClause.trim(),'experience');return {accepted:true,reason:'verified_social_api_corroborated_by_mandatory_professional_experience',evidence};}
  return reject('no_explicit_social_type_or_corroborated_required_experience');
}
