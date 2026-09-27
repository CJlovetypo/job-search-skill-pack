import {INTERNAL_RECORDS_FILE} from '../maintenance-paths.mjs';
import {businessVocabulary} from './lib/business-taxonomy.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {CORE_ROOT,PACK_ROOT} from '../runtime-context.mjs';
import {loadCompanyInputs,buildCompanyRecords,researchQueue,validateReview,campaignProgress,indexById} from './lib/company-records.mjs';
import {prepareReviewPublication,publishReviewedWork,companyPublicationTargets,validateApprovalManifest} from './lib/company-review-publication.mjs';
import {recoverPublication,clearAbandonedPublicationLock} from './lib/company-publication-transaction.mjs';
import {evaluateCalibration,verifyCalibrationSources} from './lib/company-review-calibration.mjs';

const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
async function save(p,value,{exclusive=false,compact=false}={}) {
  await fs.mkdir(path.dirname(p),{recursive:true});
  const body=JSON.stringify(value,null,compact?0:2)+'\n';
  if(exclusive)return fs.writeFile(p,body,{flag:'wx'});
  const tmp=p+'.'+randomUUID()+'.tmp';await fs.writeFile(tmp,body);await fs.rename(tmp,p);
}
function artifactPath(p) {
  const root=path.join(PACK_ROOT,'job-search/artifacts'),full=path.resolve(p),rel=path.relative(root,full);
  if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('复核工作目录必须位于 job-search/artifacts');
  return full;
}
async function documentsFromFiles(review,root) {
  const copy=structuredClone(review);
  for(const doc of copy.documents||[])if(doc.content_file) {
    const p=path.resolve(root,doc.content_file),rel=path.relative(root,p);
    if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('正文文件必须位于本轮工作目录');
    doc.content=await fs.readFile(p,'utf8');delete doc.content_file;
  }
  return copy;
}
export async function main(argv=process.argv.slice(2)) {
  const [command,...args]=argv,opts={};
  for(let i=0;i<args.length;i++){if(!args[i].startsWith('--')||!args[i+1]||args[i+1].startsWith('--'))throw Error('参数必须为 --key value');const key=args[i].slice(2);if(Object.hasOwn(opts,key))throw Error('重复参数 '+key);opts[key]=args[++i];}
  if(!command||command==='help'){console.log('公司画像维护：init --campaign ID --out job-search/artifacts/目录 [--scope all|gaps] [--selection JSON]；export --out 画像.json；next --work 目录 [--limit 4]；record --work 目录 --file 复核记录.json；approve --work 目录 --file 批准清单.json；calibrate --file 独立样本.json --out job-search/artifacts/报告.json；preflight --work 目录 [--trial true]；publish --work 目录；status --work 目录；recover [--mode rollback]；unlock。先本地分析，可复用真实归档正文；按需联网；新发布必须有字段评分、批准清单、通过校准的样本及未变更预检。');return;}
  if(command==='calibrate') {
    if(!opts.file||!opts.out)throw Error('calibrate需要--file 样本.json和--out 报告.json');
    const dataset=await read(path.resolve(opts.file)),report=evaluateCalibration(dataset);report.source_hashes=await verifyCalibrationSources(dataset);report.archive_verification='passed';await save(artifactPath(opts.out),report);console.log(JSON.stringify(report));return;
  }
  if(command==='recover'){if(opts.mode&&!['complete','rollback'].includes(opts.mode))throw Error('recover mode必须为complete或rollback');console.log(JSON.stringify(await recoverPublication({allowedTargets:companyPublicationTargets(),rollback:opts.mode==='rollback'})));return;}
  if(command==='unlock'){console.log(JSON.stringify(await clearAbandonedPublicationLock()));return;}
  const inputs=await loadCompanyInputs({includeResearch:command==='export'});
  if(command==='export') {
    const file=opts.out?artifactPath(opts.out):INTERNAL_RECORDS_FILE;
    const result=buildCompanyRecords(inputs);await save(file,result,{compact:true});console.log(JSON.stringify({file,companies:result.companies.length,operation:'structural_export_not_reverification'}));return;
  }
  if(command==='init') {
    if(!opts.campaign||!opts.out)throw Error('init需要 --campaign 与 --out');
    const root=artifactPath(opts.out),vocabulary=[...businessVocabulary()];
    const campaign=researchQueue(inputs.registry,{campaignId:opts.campaign,vocabulary,reuseEvidence:true});
    if(!['all','gaps'].includes(opts.scope||'all'))throw Error('scope必须为all或gaps');
    campaign.scope=opts.scope||'all';
    if(campaign.scope==='gaps') {
      const formal=indexById(await read(path.join(CORE_ROOT,'data/company-records.json'))),uncertain=new Set(['unknown','missing','unresolved','partial','verified_unresolved']);
      campaign.companies=campaign.companies.map(c=>({...c,requested_fields:campaign.required_fields.filter(f=>uncertain.has(formal.get(c.company_id)?.governance.fields[f]?.status))})).filter(c=>c.requested_fields.length);
    }
    if(opts.selection) {
      const selection=await read(path.resolve(opts.selection)),known=new Map(campaign.companies.map(c=>[c.company_id,c]));
      if(!Array.isArray(selection.companies)||!selection.companies.length||new Set(selection.companies.map(c=>c.company_id)).size!==selection.companies.length)throw Error('selection需要不重复的companies');
      campaign.companies=selection.companies.map(c=>{const row=known.get(c.company_id);if(!row)throw Error('选择主体不在范围');const fields=c.requested_fields||row.requested_fields||campaign.required_fields;if(!fields.length||new Set(fields).size!==fields.length||fields.some(f=>!(row.requested_fields||campaign.required_fields).includes(f)))throw Error('选择字段不在范围');return {...row,requested_fields:fields};});
    }
    await save(path.join(root,'campaign.json'),campaign,{exclusive:true});
    await save(path.join(root,'baseline.json'),inputs,{exclusive:true});
    console.log(JSON.stringify({work:root,companies:campaign.companies.length,searched:0,reviewed:0}));return;
  }
  if(!opts.work)throw Error('需要 --work');
  const root=artifactPath(opts.work),campaign=await read(path.join(root,'campaign.json'));
  const dir=path.join(root,'reviews');await fs.mkdir(dir,{recursive:true});
  const reviews={companies:await Promise.all((await fs.readdir(dir)).filter(f=>f.endsWith('.json')).sort().map(f=>read(path.join(dir,f))))};
  if(command==='approve') {
    if(!opts.file)throw Error('approve需要--file');
    const approval=await read(path.resolve(opts.file));validateApprovalManifest(approval,campaign,reviews.companies);
    await save(path.join(root,'approval.json'),approval);console.log(JSON.stringify({approved_fields:approval.fields.length,publication:false}));return;
  }
  if(command==='preflight') {
    if(opts.trial&&!['true','false'].includes(opts.trial))throw Error('trial必须为true或false');
    const {summary}=await prepareReviewPublication(root,{trial:opts.trial==='true'});await save(path.join(root,'preflight.json'),summary);
    console.log(JSON.stringify({companies:summary.companies,fields:summary.fields,changed_fields:summary.changes.length,publishable:summary.publishable,calibration_status:summary.calibration_status,plan_hash:summary.plan_hash,file:path.join(root,'preflight.json')}));return;
  }
  if(command==='publish') {console.log(JSON.stringify(await publishReviewedWork(root)));return;}
  if(command==='record') {
    if(!opts.file)throw Error('record需要 --file');
    let record=await documentsFromFiles(await read(path.resolve(opts.file)),root);
    const existing=reviews.companies.find(r=>r.company_id===record.company_id);
    if(existing) {
      if(record.campaign_id!==existing.campaign_id)throw Error('不能跨批次合并');
      const docs=new Map(existing.documents.map(d=>[d.id,d]));
      for(const d of record.documents||[]) {if(docs.has(d.id)&&JSON.stringify(docs.get(d.id))!==JSON.stringify(d))throw Error('证据ID已存在且内容不同');docs.set(d.id,d);}
      for(const [key,value] of Object.entries(record.decisions||{}))if(existing.decisions[key]&&JSON.stringify(existing.decisions[key])!==JSON.stringify(value))throw Error('字段已有不同结论，请新建修订批次');
      record={...existing,...record,searches:[...existing.searches,...record.searches],documents:[...docs.values()],decisions:{...existing.decisions,...record.decisions}};
    }
    validateReview(record,campaign);
    const file=path.join(dir,record.company_id+'.json');
    await save(path.join(root,'submissions',record.company_id+'-'+randomUUID()+'.json'),record,{exclusive:true});
    await save(file,record);console.log(JSON.stringify({file,company_id:record.company_id,fields:Object.keys(record.decisions).length}));return;
  }
  const progress=campaignProgress(campaign,reviews,inputs.cities);
  if(command==='next') {
    const limit=Number(opts.limit||4);if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('limit必须为1-100');
    // No labels/descriptions/evidence from the old baseline are sent to the researcher.
    const pending=progress.companies.filter(c=>!c.static_complete).slice(0,limit);
    console.log(JSON.stringify({campaign_id:campaign.campaign_id,started_at:campaign.started_at,required_fields:campaign.required_fields,
      companies:pending.map(({company_id,display_name,aliases,recruitment_urls,reviewed_fields,requested_fields})=>({company_id,display_name,aliases,recruitment_urls,reviewed_fields,requested_fields}))}));return;
  }
  if(command==='status') {
    await save(path.join(root,'progress.json'),progress);
    const {companies,...summary}=progress;console.log(JSON.stringify(summary));return;
  }
  throw Error('未知公司画像命令：'+command);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
