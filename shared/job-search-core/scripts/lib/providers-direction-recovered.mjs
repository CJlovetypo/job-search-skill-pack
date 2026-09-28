import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {createClient} from './http.mjs';
import {splitCommonBody} from './providers-common.mjs';
import {normalizeJobLocations,jobCityStatus} from './locations.mjs';
import {reviewRecruitment} from './recruitment-policy.mjs';
import {SEARCH_MODE} from './search-mode.mjs';

// Anonymous public contracts verified 2026-09-19. Scope is these employers only.
const {CUSTOM_PROVIDERS_FILE}=await import('../../registry.mjs');
const configs=JSON.parse(await readFile(CUSTOM_PROVIDERS_FILE,'utf8')).providers;
const keys=new Set(['tencent','alibaba','baidu','jd','bilibili','kuaishou','pdd','xiaohongshu']);
const clone=x=>structuredClone(x),str=x=>x==null?'':String(x);
const get=(o,p)=>p==='$'?o:p?.split('.').reduce((v,k)=>v?.[k],o);
const num=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x))?Number(x):null;
const clean=x=>splitCommonBody(x||'').description;
const locs=x=>Array.isArray(x)?x.flatMap(locs):x&&typeof x==='object'?locs(x.name??x.cityName??x.label??x.workCity??''):str(x).split(/[,，、;/；]+/).map(s=>s.trim()).filter(Boolean);
const activeTitle=t=>str(t).replace(/(?:需|可|要求|接受)?提前实习/g,'');
const internTitle=t=>/实习生|实习岗|日常实习|暑期实习|研究型实习|转正实习|\bintern(?:ship)?\b/i.test(activeTitle(t));
const activity=t=>/校园大使|夏令营|训练营|博士后|postdoc/i.test(t);
function professionalRequirement(value){return clean(value).split(/[\n。；;]/).find(s=>!/(?:实习|应届|校招|优先|最好|加分|prefer|intern|graduate)/i.test(s)&&/(?:[1-9]\d*\s*(?:[-~～至]\s*\d+)?\s*年(?:以上|及以上)?[^。\n]{0,24}(?:经验|工作|开发)|[1-9]\d*\+?\s*(?:to\s*\d+\s*)?years?\s+(?:of\s+)?(?:relevant\s+|professional\s+|work\s+|industry\s+)?experience|(?:具备|具有|拥有|有)[^。\n]{0,50}(?:全局操盘经验|业务拓展能力建设经验|团队管理经验|互联网行业经验))/i.test(s))||null;}

/** Exact public frontend algorithm, not personal authentication. */
export function kuaishouPublicSignature(query,timestamp){
 const key='652f962a-0575-4575-98d2-f04e2291bee2';
 const canonical=Object.keys(query).sort().flatMap(k=>{const values=(Array.isArray(query[k])?query[k]:[query[k]]).filter(v=>v!==null&&v!==undefined&&v!=='').sort().map(v=>encodeURIComponent(v).replace(/%20/g,'+'));return values.length?[k+'='+values.join(',')]:[]}).join('&');
 return createHmac('sha256',key).update(String(timestamp)+canonical+key).digest('hex');
}

export function normalizeDirectionRecovered(key,j,source,context={}){
 let id,title,locations=[],description='',requirements='',status='unknown',open='open',url=null,urlKind='official_detail',e={provider:source.provider,recovered_direction_provider:key,published_list_returned:true,api_endpoint:context.endpoint,list_file:context.listFile};
 const take=(i,t,l,d,r)=>{id=str(i);title=str(t);locations=locs(l);description=clean(d);requirements=clean(r);};
 switch(key){
  case 'tencent': {
   if(context.endpoint?.startsWith('https://careers.tencent.com/')){
    take('social:'+j.PostId,j.RecruitPostName,j.LocationName,j.Responsibility,j.Requirement);
    Object.assign(e,{upstream_post_id:j.PostId,RequireWorkYearsName:j.RequireWorkYearsName,SourceID:j.SourceID,IsValid:j.IsValid});
    if(!/不限|以下|无/.test(j.RequireWorkYearsName||'')&&/(?:[1-9]\d*|[一二两三四五六七八九十]+)\s*年[^\n]{0,12}工作经验/.test(j.RequireWorkYearsName||'')){status='social';e.professional_experience_basis=j.RequireWorkYearsName;}
    else if(/应届/.test(j.RequireWorkYearsName||''))status='formal';
    else if(professionalRequirement(requirements)){status='social';e.professional_experience_basis=professionalRequirement(requirements);}
    if(status==='social'&&/校招|校园招聘|应届/.test([title,j.RequireWorkYearsName].join(' '))){status='unknown';e.type_conflict={returned_title:title,RequireWorkYearsName:j.RequireWorkYearsName,reason:'Campus label conflicts with experienced-hiring evidence'};}
    if(j.IsValid===false)open='closed';
    url=j.PostURL||`https://careers.tencent.com/jobdesc.html?postId=${encodeURIComponent(j.PostId)}`;break;
   }
   take(j.postId,j.title||j.positionTitle,j.workCityList||j.workCities,j.desc,j.request);
   const mapping=context.projectMappings?.find(p=>str(p.projectId).split(',').includes(str(j.projectId)));
   Object.assign(e,{recruitType:j.recruitType,recruitLabelName:j.recruitLabelName,projectName:j.projectName,projectId:j.projectId,public_project_mapping:mapping});
   if(/实习/.test([j.projectName,j.recruitLabelName,mapping?.projectName].join(' ')))status='internship';
   requirements=[requirements,j.graduateBonus&&'加分项（以条文措辞判断硬性要求）\n'+clean(j.graduateBonus),j.internBonus&&'实习补充要求\n'+clean(j.internBonus)].filter(Boolean).join('\n\n');
   url=`https://join.qq.com/post_detail.html?postid=${encodeURIComponent(id)}`;break;
  }
  case 'alibaba':
   take(j.id,j.name,j.workLocations,j.description,j.requirement);
   Object.assign(e,{batchId:j.batchId,batchName:j.batchName,categoryType:j.categoryType,graduationTime:j.graduationTime,status:j.status,experience:j.experience,degree:j.degree});
   if(/实习/.test(j.batchName||''))status='internship';
   else if(j.categoryType==='freshman')status='formal';
   else if(context.endpoint?.startsWith('https://talent.alibaba.com/')&&(num(j.experience?.from)>0||professionalRequirement(requirements))){status='social';e.professional_experience_basis=j.experience?.from>0?j.experience:professionalRequirement(requirements);}
   if(j.status!=null&&j.status!=='recruit')open='closed';
   url=j.positionUrl?new URL(j.positionUrl,context.endpoint).href:`https://campus-talent.alibaba.com/campus/position/${encodeURIComponent(id)}`;
   if(context.endpoint?.startsWith('https://talent.alibaba.com/')&&!j.positionUrl){url='https://talent.alibaba.com/off-campus/position-list';urlKind='official_listing';}break;
  case 'baidu':
   take(j.postId,j.name,j.workPlace,j.workContent,j.serviceCondition);
   Object.assign(e,{projectType:j.projectType,projectTypeCode:j.projectTypeCode,workYears:j.workYears,query_recruit_type:typeof context.requestBody==='string'?new URLSearchParams(context.requestBody).get('recruitType'):null});
   if(/实习/.test(j.projectType||''))status='internship';
   else if(/校招|应届/.test(j.projectType||''))status='formal';
   else if(professionalRequirement(requirements)){status='social';e.professional_experience_basis=professionalRequirement(requirements);}
   url=`https://talent.baidu.com/jobs/detail/${status==='internship'?'INTERN':status==='formal'?'GRADUATE':context.targetMode==='social'?'SOCIAL':'INTERN'}/${encodeURIComponent(id)}`;break;
  case 'jd': {
   const social=context.endpoint?.startsWith('https://zhaopin.jd.com/');
   take(social?'social:'+j.id:j.publishId,j.positionName,j.requirementVoList?.flatMap(x=>locs(x.workCity))||j.workCity,j.workContent,j.qualification);
   const plan=context.jdPlans?.[j.planId];Object.assign(e,{planId:j.planId,planName:j.planName,public_project:plan,positionType:j.positionType,positionTypeName:j.positionTypeName,recruitType:j.recruitType,workYears:j.workYears,positionId:j.positionId});
   if(/实习/.test([j.planName,plan?.planName,plan?.name,plan?.project_type,j.positionTypeName].join(' ')))status='internship';
   else if(/应届/.test(plan?.project_type||''))status='formal';
   else if(social&&professionalRequirement(requirements)){status='social';e.professional_experience_basis=professionalRequirement(requirements);}
   url=social?'https://zhaopin.jd.com/web/job/job_info_list/3':`https://campus.jd.com/#/newDetails?publishId=${encodeURIComponent(id)}`;urlKind=social?'official_listing':'official_detail';break;
  }
  case 'bilibili': {
   const body=clean(j.positionDescription),m=/(?:^|\n)\s*(?:工作要求|任职要求|岗位要求|任职资格)\s*[:：]?/m.exec(body);
   take(j.id,j.positionName,j.workLocation,m?body.slice(0,m.index):body,m?body.slice(m.index):'');
   Object.assign(e,{positionTypeName:j.positionTypeName,recruitType:j.recruitType,campusProjectId:j.campusProjectId});
   if(j.positionTypeName==='实习')status='internship';
   else if(j.positionTypeName==='全职'&&j.recruitType===0&&context.endpoint?.includes('/api/srs/'))status='social';
   else if(j.positionTypeName==='全职'&&j.recruitType===1)status='formal';
   url=`https://jobs.bilibili.com/${context.endpoint?.includes('/api/srs/')?'social':'campus'}/positions/${encodeURIComponent(id)}`;break;
  }
  case 'xiaohongshu':
   take(j.positionId,j.positionName,j.workplace,j.duty,j.qualification);
   Object.assign(e,{recruitType:j.recruitType,recruitStatus:j.recruitStatus,workExperience:j.workExperience,education:j.education,jobProjectName:j.jobProjectName});
   status=j.recruitType==='intern_recruit'?'internship':j.recruitType==='club_recruit'?'social':j.recruitType==='school_recruit'?'formal':'unknown';
   if(j.recruitStatus!=null&&j.recruitStatus!=='in_recruitment')open='closed';
   url=`https://job.xiaohongshu.com/${status==='internship'?'campus/intern':status==='formal'?'campus':context.targetMode==='internship'?'campus/intern':'social'}/position/${encodeURIComponent(id)}`;break;
  case 'pdd':
   take(j.id,j.name,j.workLocationName||j.workLocation,j.jobDuty,j.serveRequirement);
   Object.assign(e,{recruitType:j.recruitType,recruitTypeName:j.recruitTypeName,code:j.code,graduationYear:j.graduationYear});
   if(internTitle(title))status='internship';
   url=j.shareUrl||source.primary_entry_url||'https://careers.pddglobalhr.com/campus/intern';urlKind=j.shareUrl?'official_detail':'official_listing';break;
  case 'kuaishou':
   take(j.id,j.name,j.workLocations||j.workLocationsCode||j.workLocationCode,j.description,j.positionDemand);
   Object.assign(e,{positionNatureCode:j.positionNatureCode,recruitProjectCode:j.recruitProjectCode,positionStatusCode:j.positionStatusCode,workExperienceCode:j.workExperienceCode});
   status=j.positionNatureCode==='C002'?'internship':j.positionNatureCode==='C001'&&j.recruitProjectCode==='socialr'?'social':'unknown';
   if(j.positionStatusCode!=null&&j.positionStatusCode!=='Release')open='closed';
   url=`https://zhaopin.kuaishou.cn/recruit/e/#/official/${j.positionNatureCode==='C002'?'trainee':'social'}/job-info/${encodeURIComponent(id)}`;break;
  default:throw Error('Unsupported recovered direction provider '+key);
 }
 if(internTitle(title))status='internship';if(activity(title))status='activity';
 const coreComplete=key==='tencent'&&!context.endpoint?.startsWith('https://careers.tencent.com/')?!!clean(j.desc)&&!!clean(j.request):description.length>15&&requirements.length>15;
 e.open_basis='Returned by the current anonymous public published-job list; explicit closed status takes precedence.';
 e.classification_basis='Returned job fields, current returned project identity, or explicit title/professional requirements. Request filter alone is insufficient.';
 const conditionKeys=['graduationTime','graduationYear','internshipBeginDate','internshipDays','workWeeklyDays','selectedWorks','withFile','topicDetail','topicRequirement','projectInternDirections','subDirectionDtos','bonus','requirementVoList','educationLimitCode','workExperienceCode','salaryMin','salaryMax','workingHoursNature','recruitStartDate','recruitEndDate','workExperience','degree','education','workYears','RequireWorkYearsName'];
 let job={job_id:id,company_id:source.company_id,company_name:source.display_name,title,locations_raw:locations,description,requirements,body_complete:coreComplete,formal_status:status,open_status:open,official_url:url,job_url_kind:urlKind,recruitment_evidence:e,raw_metadata:{body_fields:{description:j.description??j.desc??j.workContent??j.jobDuty??j.duty??j.positionDescription??j.Responsibility??null,requirements:j.requirement??j.request??j.serviceCondition??j.qualification??j.serveRequirement??j.positionDemand??j.Requirement??null,graduateBonus:j.graduateBonus??null,internBonus:j.internBonus??null},experience:j.experience??j.workExperience??j.workYears??j.RequireWorkYearsName??null,education:j.degree??j.education??null,structured_conditions:Object.fromEntries(conditionKeys.filter(k=>j[k]!==undefined&&j[k]!==null).map(k=>[k,j[k]]))},raw_file:context.rawFile||context.listFile||''};
 const location=normalizeJobLocations(job);job={...job,cities:location.cities,location_special:location.special,location_unknown:location.unknown,location_unresolved:location.unresolved};
 return reviewRecruitment(job,context.targetMode||'social');
}

export async function collectRecoveredDirection(source,options={}){
 const targetMode=options.targetMode||SEARCH_MODE.id;
 const pair=Object.entries(configs).find(([k,c])=>keys.has(k)&&c.provider===source.provider);
 if(targetMode==='campus'||!['social','internship'].includes(targetMode)||!pair)return null;
 const [key,original]=pair;if(targetMode==='social'&&key==='pdd')return null;
 const opts={mode:'full',pageSize:20,maxPages:1000,detailConcurrency:3,...options};
 for(const field of ['pageSize','maxPages','detailConcurrency'])if(!Number.isInteger(opts[field])||opts[field]<1)throw Error(field+' must be a positive integer');
 if(!['list','full'].includes(opts.mode))throw Error('mode must be list or full');
 const limit=opts.validationMaxDetails??opts.maxDetails??null;if(limit!==null&&(!Number.isInteger(limit)||limit<0))throw Error('detail limit must be a non-negative integer');
 const cfg=clone(original),client=opts.client||createClient(opts),pages=[],all=new Map(),failures=[],streams=[],totals=new Map();
 const checked=new Date().toISOString(),context={targetMode};let csrf=null,completed=0,detailRequests=0,detailsSkippedLimit=0,detailsSkippedCity=0,detailFailures=0;
 // Baidu SOCIAL/INTERN both accept 10/20; 30 is explicitly rejected by the live endpoint.
 const size=key==='xiaohongshu'?Math.max(10,Math.min(100,opts.pageSize)):Math.min(key==='baidu'?20:key==='tencent'&&targetMode==='social'?10:100,opts.pageSize);
 async function request(template,purpose){
  const q=clone(template);q.headers||={};
  if(key==='alibaba'&&purpose!=='public_bootstrap'){const cookie=client.cookieValue('XSRF-TOKEN',q.url);if(!cookie)throw Error('Missing fresh public Alibaba XSRF cookie');q.headers['X-XSRF-TOKEN']=decodeURIComponent(cookie);}
  if(key==='bilibili'&&csrf)q.headers['X-CSRF']=csrf;
  if(key==='tencent'&&targetMode==='social'){const u=new URL(q.url);u.searchParams.set('timestamp',Date.now());q.url=u.href;}
  if(key==='kuaishou'){const query=Object.fromEntries(new URL(q.url).searchParams),timestamp=Date.now();q.headers.sign=kuaishouPublicSignature(query,timestamp);q.headers.signTimestamp=String(timestamp);}
  const r=await client.request(q,{purpose});if(r.record.http_status!==200)throw Error('HTTP '+r.record.http_status);
  if(purpose!=='public_bootstrap'&&r.data==null)throw Error('Public API returned non-JSON');
  if(r.data?.success===false||key==='kuaishou'&&r.data?.code!==0)throw Error('Public API rejected query: '+(r.data.message||r.data.errorMsg||r.data.code));
  return r;
 }
 const add=(q=clone(cfg.list_requests[0]),extra={})=>streams.push({request:q,items:cfg.items_path,total:cfg.total_path,page:cfg.page_path,size:cfg.size_path,base:cfg.page_base??1,context,...extra});
 try{
  if(key==='alibaba'){
   if(targetMode==='social'){
    await request({url:'https://talent.alibaba.com/',method:'GET'},'public_bootstrap');
    const q={url:'https://talent.alibaba.com/position/search',method:'POST',headers:{'Content-Type':'application/json',Referer:'https://talent.alibaba.com/off-campus/position-list'},body:{pageIndex:1,pageSize:size,channel:'group_official_site',language:'zh'}};add(q);
   }else{
    for(const q of cfg.bootstrap_requests)await request(q,'public_bootstrap');
    const r=await request(cfg.discovery_requests[0],'public_project_discovery'),batches=r.data.content?.internship;
    if(!Array.isArray(batches))throw Error('Missing live internship batches');
    for(const batch of batches.filter(b=>/实习/.test(b.name||''))){const q=clone(cfg.list_requests[0]);q.body.batchId=batch.id;add(q,{context:{...context,batch,projectFile:r.record.response_file}});}
   }
  }else if(key==='tencent'&&targetMode==='social'){
   const url=new URL('https://careers.tencent.com/tencentcareer/api/post/Query');for(const [k,v]of Object.entries({countryId:'',cityId:'',bgIds:'',productId:'',categoryId:'',parentCategoryId:'',attrId:'1',keyword:'',pageIndex:1,pageSize:size,language:'zh-cn',area:'cn'}))url.searchParams.set(k,v);
   add({url:url.href,method:'GET',headers:{Referer:'https://careers.tencent.com/search.html?query=at_1'}},{items:'Data.Posts',total:'Data.Count',page:'pageIndex',size:'pageSize',base:1});
  }else if(key==='tencent'){
   const r=await request(cfg.discovery_requests[0],'public_project_discovery');
   context.projectMappings=(r.data.data||[]).flatMap(p=>(p.subProjectList||[]).filter(x=>x.status===1&&/实习/.test(x.projectName)).map(x=>({...x,raw_file:r.record.response_file})));
   if(!context.projectMappings.length)throw Error('No currently published internship mapping');
   const q=clone(cfg.list_requests[0]);q.body.projectMappingIdList=context.projectMappings.map(x=>x.mappingId);add(q);
  }else if(key==='jd'&&targetMode==='internship'){
   const r=await request(cfg.discovery_requests[0],'public_project_discovery');context.jdPlans={};
   for(const p of r.data.body?.projectList||[])if(p.release===true)for(const plan of (p.groupList||[]).flatMap(g=>g.planMapList||[]))context.jdPlans[plan.id]={...plan,project_type:p.type,project_code:p.code,raw_file:r.record.response_file};
   const q=clone(cfg.list_requests[0]),url=new URL(q.url);url.searchParams.set('type','internship');q.url=url.href;add(q);
  }else if(key==='jd'){
   const headers={'Content-Type':'application/x-www-form-urlencoded',Referer:'https://zhaopin.jd.com/web/job/job_info_list/3'},body='workCityJson=[]&jobTypeJson=[]&jobSearch=&depTypeJson=[]';
   const count=await request({url:'https://zhaopin.jd.com/web/job/job_count',method:'POST',headers,body},'public_job_count');
   if(num(count.data)===null)throw Error('Missing social count');
   add({url:'https://zhaopin.jd.com/web/job/job_list',method:'POST',headers,body:'pageIndex=1&pageSize='+size+'&'+body},{items:'$',total:null,explicitTotal:num(count.data),page:'pageIndex',size:'pageSize',base:1,context:{...context,countFile:count.record.response_file}});
  }else if(key==='bilibili'){
   const r=await request(cfg.discovery_requests[0],'public_csrf_bootstrap');csrf=r.data.data;if(typeof csrf!=='string'||!csrf)throw Error('Missing public CSRF token');client.setCookie('X-CSRF',csrf,cfg.discovery_requests[0].url,{sourceRecord:r.record});
   const q=clone(cfg.list_requests[0]);if(targetMode==='social'){q.url=q.url.replace('/api/campus/','/api/srs/');q.body.workTypeList=[];q.body.positionTypeList=[];}else{q.body.workTypeList=[0];q.body.positionTypeList=[0];}add(q);
  }else if(key==='baidu'){
   const q=clone(cfg.list_requests[0]),body=new URLSearchParams(q.body);body.set('recruitType',targetMode==='social'?'SOCIAL':'INTERN');q.headers.Referer='https://talent.baidu.com/jobs/list?recruitType='+body.get('recruitType');q.body=body.toString();add(q);
  }else if(key==='xiaohongshu'){
   const q=clone(cfg.list_requests[0]);q.body.recruitType=targetMode==='social'?'social':'intern';add(q);
  }else if(key==='pdd'){
   const q=clone(cfg.list_requests[0]);q.url=q.url.replace('/position/list','/position/train/list');add(q);
  }else if(key==='kuaishou'){
   const url=new URL('https://zhaopin.kuaishou.cn/recruit/e/api/v1/open/positions/simple');for(const [k,v]of Object.entries({pageNum:1,pageSize:size,positionNatureCode:targetMode==='social'?'C001':'C002',...(targetMode==='social'?{recruitProject:'socialr'}:{}),workLocationCode:'domestic'}))url.searchParams.set(k,v);
   add({url:url.href,method:'GET',headers:{Referer:'https://zhaopin.kuaishou.cn/recruit/e/',Origin:'https://zhaopin.kuaishou.cn'}},{items:'result.list',total:'result.total',page:'pageNum',size:'pageSize',base:1});
  }
  if(!streams.length)throw Error('No verified current target-direction stream');
  for(let i=0;i<streams.length;i++){
   const stream=streams[i],seen=new Set();let ended=false,firstTotal=null;
   try{for(let page=1;page<=opts.maxPages;page++){
    const q=clone(stream.request),value=page-1+stream.base;
    if(q.method==='GET'){const u=new URL(q.url);u.searchParams.set(stream.page,value);u.searchParams.set(stream.size,size);q.url=u.href;}
    else if(typeof q.body==='string'){const b=new URLSearchParams(q.body);b.set(stream.page,value);b.set(stream.size,size);q.body=b.toString();}
    else{q.body[stream.page]=value;q.body[stream.size]=size;}
    const r=await request(q,'job_list'),rows=get(r.data,stream.items),total=stream.explicitTotal??num(get(r.data,stream.total));
    if(!Array.isArray(rows))throw Error('Changed list schema '+stream.items);
    if(firstTotal!==null&&total!==firstTotal)failures.push(`Stream ${i+1}: server_total_changed`);if(firstTotal===null)firstTotal=total;totals.set(i,total);
    const before=seen.size,ids=[];
    for(const raw of rows){const ctx={...stream.context,endpoint:stream.request.url,requestBody:r.record.body,listFile:r.record.response_file,rawFile:r.record.response_file},job=normalizeDirectionRecovered(key,raw,source,ctx);if(!job.job_id||!job.title)throw Error('Missing stable ID/title');ids.push(job.job_id);seen.add(job.job_id);if(!all.has(job.job_id))all.set(job.job_id,{job,raw,context:ctx});else all.get(job.job_id).job.recruitment_evidence.additional_list_files=[...(all.get(job.job_id).job.recruitment_evidence.additional_list_files||[]),r.record.response_file];}
    const evidence={stream:i+1,page,request_url:r.record.url,request_body:r.record.body,raw_file:r.record.response_file,job_ids:ids,new_ids:seen.size-before,server_total:total,end_evidence:null};pages.push(evidence);
    if(new Set(ids).size!==ids.length||seen.size-before<ids.length)failures.push(`Stream ${i+1}: duplicate_ids_on_or_across_pages`);
    if(!rows.length||total!==null&&seen.size>=total){evidence.end_evidence=!rows.length?'empty_page':'server_total_reached';if(total!==null&&seen.size!==total)failures.push(`Stream ${i+1}: terminal_unique_count_mismatch ${seen.size}/${total}`);ended=true;break;}
    if(seen.size===before){evidence.end_evidence='repeated_page_with_no_new_ids';failures.push(`Stream ${i+1}: repeated_page`);break;}
   }}catch(e){failures.push(`Stream ${i+1}: ${e.message}`);}
   if(ended)completed++;else failures.push(`Stream ${i+1}: no reconciled endpoint terminal signal within maxPages`);
  }
 }catch(e){failures.push(e.message);}
 // Missing details are retained, never silently dropped from an otherwise successful list.
 const queue=[];for(const item of all.values()){
  if(opts.titleFilter&&!opts.titleFilter(item.job.title))continue;
  const j=item.job;if(j.open_status==='closed'||['formal','parttime','activity',targetMode==='social'?'internship':'social'].includes(j.formal_status))continue;
  const needsType=key==='xiaohongshu'&&j.formal_status==='unknown';
  const needsBody=opts.mode==='full'&&!j.body_complete;
  if(!needsType&&!needsBody)continue;
  if(jobCityStatus(j,opts.cityFilters??opts.cities??[])==='excluded'){detailsSkippedCity++;continue;}
  if(!['tencent','jd','pdd','xiaohongshu','kuaishou'].includes(key)||key==='jd'&&targetMode==='social')continue;queue.push(item);
 }
 let next=0;await Promise.all(Array.from({length:Math.min(opts.detailConcurrency,queue.length)},async()=>{while(next<queue.length){const item=queue[next++];if(limit!==null&&detailRequests>=limit){detailsSkippedLimit++;continue;}detailRequests++;
  try{let q=clone(cfg.detail_request),id=item.job.job_id;
   if(key==='tencent'&&targetMode==='social')q={url:'https://careers.tencent.com/tencentcareer/api/post/ByPostId?'+new URLSearchParams({postId:item.raw.PostId,language:'zh-cn'}),method:'GET',headers:{Referer:'https://careers.tencent.com/jobdesc.html?postId='+item.raw.PostId}};
   else if(key==='kuaishou')q={url:'https://zhaopin.kuaishou.cn/recruit/e/api/v1/open/position?id='+encodeURIComponent(id),method:'GET',headers:{Referer:'https://zhaopin.kuaishou.cn/recruit/e/'}};
   else{const u=new URL(q.url);if(key==='tencent')u.searchParams.set('postId',id);if(key==='xiaohongshu')u.searchParams.set('positionId',id);if(key==='jd')u.pathname=u.pathname.replace(/\/[^/]+$/,'/'+encodeURIComponent(id));if(key==='pdd')q.body.id=id;q.url=u.href;}
   const r=await request(q,'job_detail'),data=r.data.data??r.data.body??r.data.result??r.data.Data;if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Missing detail object');
   const merged={...item.raw,...data},job=normalizeDirectionRecovered(key,merged,source,{...item.context,rawFile:r.record.response_file});if(job.job_id!==id)throw Error('Detail returned a different ID');
   job.recruitment_evidence.list_file=item.context.listFile;item.job=job;
  }catch(e){detailFailures++;failures.push(`Detail ${item.job.job_id}: ${e.message}`);}
 }}));
 const jobs=[...all.values()].map(x=>x.job),unknown=jobs.filter(j=>j.open_status!=='closed'&&j.formal_status==='unknown').length;
 const incomplete=opts.mode==='full'?jobs.filter(j=>j.open_status!=='closed'&&j.formal_status===targetMode&&jobCityStatus(j,opts.cityFilters??opts.cities??[])!=='excluded'&&!j.body_complete).length:0;
 if(unknown)failures.push(`${unknown} published jobs have unconfirmed recruitment type`);if(incomplete)failures.push(`${incomplete} target jobs lack a complete JD`);if(detailsSkippedLimit)failures.push(`${detailsSkippedLimit} details skipped by validation limit`);
 const complete=streams.length>0&&completed===streams.length&&!failures.length,serverTotal=totals.size===streams.length&&[...totals.values()].every(x=>x!==null)?[...totals.values()].reduce((a,b)=>a+b,0):null;
 return {company_id:source.company_id,display_name:source.display_name,checked_at:checked,jobs,coverage:{status:complete?'complete':pages.length?'partial':'failed',pages,server_total:serverTotal,jobs_observed:jobs.length,reason:failures.join('; ')||'All configured recovered public direction streams reconciled unique IDs with endpoint totals',mode:opts.mode,target_mode:targetMode,formal_type_unknown:unknown,incomplete_formal_bodies:incomplete,detail_requests:detailRequests,detail_failures:detailFailures,details_skipped_limit:detailsSkippedLimit,details_skipped_city:detailsSkippedCity,scope:'Verified employer-specific direction streams only; not all group subsidiaries or other portals'},requests:client.records};
}
