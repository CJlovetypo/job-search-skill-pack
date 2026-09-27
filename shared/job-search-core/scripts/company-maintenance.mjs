import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {PACK_ROOT, MODE_ROOTS} from '../runtime-context.mjs';
import {SOURCE_REGISTRY_FILE, COMPANY_BUSINESS_FILE, COMPANY_OWNERSHIP_FILE} from '../registry.mjs';
import {INDUSTRIES} from './lib/industry-routing.mjs';
import {ownershipDatasetProblems} from './lib/ownership.mjs';
import {loadCompanyContext} from './lib/company-records.mjs';

const read = async file => {try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {companies:[]};throw e;}};
const hasEvidence = row => row?.evidence?.some(e => /^https?:\/\//.test(e.url||'') && e.title && e.note && e.checked_at);
export function auditLabels({registry, ownership, business, cities}) {
  const sources=registry.companies, byBusiness=new Map(business.companies.map(c=>[c.company_id,c]));
  const ids=new Set(INDUSTRIES.map(i=>i.id)), vocabulary=new Map();
  for(const c of business.companies)for(const tag of new Set(c.business_tags||[]))vocabulary.set(tag,(vocabulary.get(tag)||0)+1);
  return {schema_version:1,checked_at:new Date().toISOString(),read_only:true,companies:sources.length,
    industries:INDUSTRIES.map(i=>({...i,companies:sources.filter(c=>c.industry_tags?.includes(i.id)).length})),
    industry_issues:sources.filter(c=>!c.industry_tags?.length||c.industry_tags.some(t=>!ids.has(t))).map(c=>({company_id:c.company_id,industry_tags:c.industry_tags||[]})),
    ownership_issues:ownershipDatasetProblems(sources,ownership),
    business_issues:sources.flatMap(c=>{const b=byBusiness.get(c.company_id);return !b?.business_tags?.length||b.status!=='verified'||!hasEvidence(b)?[{company_id:c.company_id,display_name:c.display_name,status:b?.status||'missing',has_dated_evidence:!!hasEvidence(b)}]:[];}),
    business_vocabulary:[...vocabulary].sort(([a],[b])=>a.localeCompare(b,'zh')).map(([tag,companies])=>({tag,companies})),
    cities:Object.fromEntries(Object.entries(cities).map(([mode,index])=>{const byId=new Map(index.companies.map(c=>[c.company_id,c]));return [mode,{updated_at:index.updated_at||null,missing:sources.filter(c=>!byId.has(c.company_id)).length,complete:sources.filter(c=>byId.get(c.company_id)?.city_coverage_complete===true).length,with_cities:sources.filter(c=>byId.get(c.company_id)?.cities?.length).length,unknown_or_partial:sources.filter(c=>byId.get(c.company_id)?.city_coverage_complete!==true).length}];})),
    notes:['仅盘点现有数据，不联网、不重标、不刷新；证据缺口不是求职流程的前置条件。','现有行业枚举保留；分类迁移及新证据优先级另行审核。']};
}
export function reviewLabels({registry, ownership, business}) {
  const byBusiness=new Map(business.companies.map(c=>[c.company_id,c]));
  const byOwnership=new Map(ownership.companies.map(c=>[c.company_id,c]));
  const companies=registry.companies.map(company=>{
    const businessRow=byBusiness.get(company.company_id),ownershipRow=byOwnership.get(company.company_id);
    const industryBasis=company.industry_assignment?.basis||company.industry_tag_basis||null;
    const industryReviewed=company.industry_assignment?.status==='reviewed_routing'||!!company.industry_tag_basis?.business_evidence;
    const businessReviewed=businessRow?.status==='verified'&&hasEvidence(businessRow);
    const businessPartial=!!businessRow?.business_tags?.length&&!businessReviewed;
    const ownershipReviewed=['verified','verified_unresolved'].includes(ownershipRow?.status);
    return {company_id:company.company_id,display_name:company.display_name,
      industry:{tags:company.industry_tags||[],status:industryReviewed?'evidence_reviewed':'current_routing_retained',basis:industryBasis},
      business:{tags:businessRow?.business_tags||[],status:businessReviewed?'evidence_reviewed':businessPartial?'partial_evidence':'evidence_missing',summary:businessRow?.business_summary||'',evidence:businessRow?.evidence||[]},
      ownership:{tag:ownershipRow?.ownership_tag||null,status:ownershipReviewed?'evidence_reviewed':'evidence_missing',reason:ownershipRow?.reason||'',evidence:ownershipRow?.evidence||[]}};
  });
  const count=(dimension,status)=>companies.filter(c=>c[dimension].status===status).length;
  return {schema_version:1,generated_at:new Date().toISOString(),read_only:true,summary:{companies:companies.length,
    industry_evidence_reviewed:count('industry','evidence_reviewed'),industry_retained:count('industry','current_routing_retained'),
    business_evidence_reviewed:count('business','evidence_reviewed'),business_partial:count('business','partial_evidence'),business_missing:count('business','evidence_missing'),
    ownership_evidence_reviewed:count('ownership','evidence_reviewed'),ownership_missing:count('ownership','evidence_missing')},companies};
}
export function maintenanceCommand(command, options={}) {
  const allowed=command==='cities'?['mode','only','industries','concurrency','max-pages','resume','out']:command==='ownership'?['source','apply','out']:['audit','review'].includes(command)?['out']:[];
  for(const key of Object.keys(options))if(!allowed.includes(key))throw Error('该维护命令不支持 --'+key);
  if(command==='cities'){
    if(!Object.hasOwn(MODE_ROOTS,options.mode))throw Error('城市维护必须显式指定 --mode campus|internship|social');
    const entry=path.join(PACK_ROOT,'shared/job-search-core/cli.mjs');
    const args=[options.mode,'refresh-cities'];
    for(const [key,value] of Object.entries(options))if(key!=='mode')args.push('--'+key,...(value===true?[]:[String(value)]));
    return {entry,args};
  }
  if(command==='ownership'){
    if(!['supplier','waiqi'].includes(options.source))throw Error('性质维护需要 --source supplier|waiqi');
    return {entry:path.join(PACK_ROOT,'shared/job-search-core/scripts',`tag-${options.source}-ownership.mjs`),args:[`--artifacts=${artifactPath(options.out||path.join(PACK_ROOT,'shared/job-search-core/state/maintenance/company-maintenance',randomUUID()))}`,...(options.apply?['--apply']:[])]};
  }
  if(!['audit','review'].includes(command))throw Error('维护命令必须为 audit、review、cities 或 ownership');
  return null;
}
function artifactPath(value){
  const full=path.resolve(value),root=path.join(PACK_ROOT,'shared/job-search-core/state/maintenance'),rel=path.relative(root,full);
  if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('维护盘点/性质证据输出必须位于 shared/job-search-core/state/maintenance 内');
  return full;
}
export async function main(argv=process.argv.slice(2)){
  const [command,...args]=argv,options={};
  if(!command||command==='help'){console.log('主动公司标签维护：audit [--out shared/job-search-core/state/maintenance/audit.json]；review [--out shared/job-search-core/state/maintenance/review.json]；cities --mode campus|internship|social [--only 公司ID]；ownership --source supplier|waiqi [--apply]。日常搜索不调用本入口。');return;}
  for(let i=0;i<args.length;i++){
    if(!args[i].startsWith('--'))throw Error('未知参数 '+args[i]);
    const key=args[i].slice(2);if(Object.hasOwn(options,key))throw Error('重复参数 --'+key);
    if(['apply','resume'].includes(key)){options[key]=true;continue;}
    if(!args[i+1]||args[i+1].startsWith('--'))throw Error('--'+key+' 缺少值');options[key]=args[++i];
  }
  const invocation=maintenanceCommand(command,options);
  if(invocation){
    const child=spawn(process.execPath,[invocation.entry,...invocation.args],{cwd:PACK_ROOT,stdio:'inherit',windowsHide:true});
    process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});return;
  }
  const {registry,ownership,business,cities}=await loadCompanyContext();
  const result=command==='review'?reviewLabels({registry,ownership,business}):auditLabels({registry,ownership,business,cities});
  if(options.out){const file=artifactPath(options.out);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({file,read_only:true,companies:result.summary?.companies??result.companies}));}
  else console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
