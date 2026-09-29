import {companyRouteEntries,recruitmentCoverage} from './recruitment-routes.mjs';
import {collectEndpoint,mergeSourceResults,sourceConfigFingerprint} from './source-collector.mjs';
import {directionSourceKey} from './direction-validation.mjs';
import {matchesSearchTitle,applyTargetedResult,nativeKeywordParameter} from './targeted-search.mjs';
import {SEARCH_MODE} from './search-mode.mjs';
import {needsBodyFetch} from './body-fetch.mjs';

const selectiveDetails=new Set(['moka','beisen','feishu','hotjob','workday','smartrecruiters','tencent','alibaba','baidu','jd','bilibili','kuaishou','pdd','xiaohongshu','meituan','openout','mihoyo','first_party']);
export async function collectTargeted(company,plan,options={},capabilities={},collector=collectEndpoint){
 const mode=options.targetMode||SEARCH_MODE.id,configs=companyRouteEntries(company,mode),results=[],strategies=[];
 const byKey=new Map((capabilities.configurations||[]).map(c=>[c.key+'|'+c.mode,c]));
 for(const {index,source} of configs){
  const key=directionSourceKey(company,source,index),proof=byKey.get(key+'|'+mode);
  const native=proof?.status==='verified_native_keyword'&&proof.mode===mode&&nativeKeywordParameter(source.provider);
  const strategy=native?'verified_native_keyword':selectiveDetails.has(source.provider)?'list_title_filter_then_detail':'list_title_filter_with_provider_fallback';
  strategies.push({source_id:source.source_id||String(index),route_id:source.route_id,provider:source.provider,strategy,proof_file:native?proof.evidence_file:null});
  for(const [n,keyword] of (native?plan.keywords:['']).entries()){
   const titleFilter=title=>matchesSearchTitle(title,plan),opts={...options,targetMode:mode,keyword,titleFilter};
   if(options.evidenceDir)opts.evidenceDir=options.evidenceDir+'/'+(source.source_id||index)+'/'+(source.route_id||'source')+'/query-'+n;
   try{
    let result=await collector(source,{...opts,mode:selectiveDetails.has(source.provider)?options.mode||'full':'list'});
    if(!selectiveDetails.has(source.provider)&&options.mode!=='list'&&(result.jobs||[]).some(j=>titleFilter(j.title)&&needsBodyFetch(j))){
     const full=await collector(source,{...opts,mode:'full'});result={...full,requests:[...(result.requests||[]),...(full.requests||[])]};strategies.at(-1).strategy='provider_full_fetch_then_title_filter';
    }
    results.push({source,result:applyTargetedResult(result,plan,strategies.at(-1).strategy)});
   }catch(e){results.push({source,result:{jobs:[],requests:[],coverage:{status:'failed',pages:0,reason:e.message,search_scope:'targeted_titles'}}});}
  }
 }
 if(!configs.length)return {company_id:company.company_id,jobs:[],requests:[],source_config_fingerprint:sourceConfigFingerprint(company,mode),coverage:{status:'unavailable',collection_complete:false,pages:0,reason:'no_applicable_direction_routes',direction_sources:recruitmentCoverage(company,mode)}};
 const merged=mergeSourceResults(company,results,{...options,targetMode:mode});
 const final=applyTargetedResult({...merged,source_config_fingerprint:sourceConfigFingerprint(company,mode)},plan,strategies);
 final.coverage.direction_sources=recruitmentCoverage(company,mode);
 final.coverage.unfiltered_observed_rows=results.reduce((n,x)=>n+(x.result.coverage.unfiltered_observed_rows||0),0);
 return final;
}
