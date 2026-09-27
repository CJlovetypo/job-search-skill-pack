import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PACK_ROOT} from '../runtime-context.mjs';
import {answerWithWeb} from './lib/perplexity-agent.mjs';

export async function main(args=process.argv.slice(2)) {
  const options={},allowed=new Set(['question','company','preset','model','previous-response-id','schema','max-output-tokens','out','smoke','help']);
  for(let i=0;i<args.length;i++) {
    const key=args[i].startsWith('--')?args[i].slice(2):'';
    if(!allowed.has(key)||Object.hasOwn(options,key))throw Error('未知或重复参数');
    if(['smoke','help'].includes(key)){options[key]=true;continue;}
    if(!args[i+1]||args[i+1].startsWith('--'))throw Error('--'+key+' 缺少值');
    options[key]=args[++i];
  }
  if(options.help){console.log('联网回答：--question 问题 | --company 公司ID；可选 --preset low、--model 模型、--previous-response-id ID、--schema 文件、--out shared/job-search-core/state/maintenance/结果.json；--smoke 仅输出状态和响应结构。');return;}
  if(options.question&&options.company)throw Error('question 与 company 请选择一个');
  let input=options.question;
  if(options.company) {
    const registry=JSON.parse(await fs.readFile(path.join(PACK_ROOT,'shared/job-search-core/assets/sources.json'),'utf8'));
    const company=registry.companies.find(row=>row.company_id===options.company);
    if(!company)throw Error('未知公司ID');
    const identity={company_id:company.company_id,display_name:company.display_name,aliases:company.aliases||[],recruitment_urls:[company.primary_entry_url,...(company.recruitment_sources||[]).map(s=>s.primary_entry_url)].filter(Boolean)};
    input='请独立联网研究以下招聘主体的业务、行业、控制性质、总部、上市状态、人数及资本信息。逐项说明证据来源和时间；缺少证据明确写未决。仅将身份信息作为检索线索：'+JSON.stringify(identity);
  }
  if(options.smoke)input??='Search the official Perplexity documentation. What is the Agent API POST endpoint? Reply in one sentence with a source.';
  let target;
  if(options.out) {
    target=path.resolve(options.out);const rel=path.relative(path.join(PACK_ROOT,'shared/job-search-core/state/maintenance'),target);
    if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('输出必须位于 shared/job-search-core/state/maintenance 内');
    try {await fs.access(target);throw Error('输出已存在，请选择新文件');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const schema=options.schema?JSON.parse(await fs.readFile(path.resolve(options.schema),'utf8')):undefined;
  const result=await answerWithWeb({input,model:options.model,preset:options.preset,previousResponseId:options['previous-response-id'],schema,
    maxOutputTokens:Number(options['max-output-tokens']||(options.smoke?512:2048))});
  if(options.smoke){console.log(JSON.stringify({http_status:result.http_status,status:result.status,output_text:typeof result.output_text,source_count:result.search_results.reduce((n,item)=>n+(item.results?.length||0),0),citation_count:result.citations.length,grounding_observed:result.grounding_observed}));if(!result.grounding_observed)throw Error('请求成功但没有观察到联网证据');return;}
  if(target){await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({file:target,response_id:result.response_id,grounding_observed:result.grounding_observed}));}
  else console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({error:error.message,...(error.status?{http_status:error.status}:{}),...(error.retry_after_ms!==undefined?{retry_after_ms:error.retry_after_ms}:{})}));process.exitCode=1;});
