import fs from 'node:fs/promises';
import path from 'node:path';
import {createClient} from './lib/http.mjs';
import {extractCareerLinks,atsConfiguration} from './discover-waiqi-zero-websites.mjs';
import {isIndividualJobRoute as detail} from './lib/career-link-scope.mjs';

const input=path.resolve(process.argv[2]||'shared/job-search-core/state/maintenance/waiqi-candidate-review/website-discovery-review.json');
const output=path.resolve(process.argv[3]||'shared/job-search-core/state/maintenance/waiqi-expansion-followup/career-revisit');
const queue=JSON.parse(await fs.readFile(input,'utf8')).filter(c=>c.state==='career_link_found_no_supported_ats');
const family=(url,html='')=>{
  const h=new URL(url).hostname;
  if(/moseeker\.com$/.test(h))return 'moseeker';
  if(/tupu360\.com$/.test(h))return 'tupu360';
  if(/ajinga\.com$/.test(h))return 'ajinga';
  if(/(?:jobs\.)?lever\.co$/.test(h))return 'lever_hint';
  if(/ashbyhq\.com$/.test(h))return 'ashby_hint';
  if(/(?:icims\.com|icims\.eu)$/.test(h))return 'icims_hint';
  if(/dayforcehcm\.com$/.test(h))return 'dayforce_hint';
  if(/(?:jobvite\.com|jobs\.jobvite\.com)$/.test(h))return 'jobvite_hint';
  if(/(?:workable\.com|apply\.workable\.com)$/.test(h))return 'workable_hint';
  if(/(?:recruitee\.com|teamtailor\.com|jobs\.personio\.(?:com|de))$/.test(h))return 'other_public_ats_hint';
  if(/platform\/.*j2w|BS3ColumnizedSearch|\bjob-tile\b/.test(html))return 'jobs2web';
  if(/eightfold/i.test(html))return 'eightfold_hint';
  if(/avature/i.test(h+' '+html))return 'avature_hint';
  if(/phenom/i.test(html))return 'phenom_hint';
  return atsConfiguration(url)?.provider||'unresolved';
};
await fs.mkdir(output,{recursive:true});let cursor=0,done=0;const results=[];
await Promise.all(Array.from({length:4},async()=>{while(cursor<queue.length){const c=queue[cursor++],dir=path.join(output,String(c.id)),file=path.join(dir,'result.json');try{const cached=JSON.parse(await fs.readFile(file,'utf8'));results.push(cached);done++;continue;}catch{}
  const client=createClient({evidenceDir:path.join(dir,'http'),timeoutMs:12000,requestBudget:{remaining:5}}),seen=new Set(),observations=[];
  const pending=(c.career_links||[]).map(x=>x.url);if(!pending.length&&c.website)pending.push(c.website);
  while(pending.length&&seen.size<5){const url=pending.shift();try{if(seen.has(url)||detail(url))continue;seen.add(url);const r=await client.request({url},{purpose:'career_interface_discovery'});const f=family(r.url||url,r.text);const links=extractCareerLinks(r.url||url,r.text).filter(x=>!detail(x.url));observations.push({url,final_url:r.url,http_status:r.record.http_status,title:r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim(),platform:f,api_configuration:atsConfiguration(r.url||url),links:links.slice(0,20),response_file:r.record.response_file,response_sha256:r.record.response_sha256});if(r.record.http_status===200&&f==='unresolved')pending.push(...links.map(x=>x.url).filter(x=>!seen.has(x)));if(r.record.http_status===200&&f!=='unresolved')break;}catch(e){observations.push({url,error:e.message});}}
  const row={waiqi_company_id:c.id,display_name:c.name,checked_at:new Date().toISOString(),observations,requests:client.records,status:observations.some(x=>x.http_status===200&&x.platform!=='unresolved')?'platform_identified_requires_api_identity_review':'unresolved',job_details_requested:0};await fs.mkdir(dir,{recursive:true});await fs.writeFile(file,JSON.stringify(row,null,2));results.push(row);done++;if(done%25===0)console.log(JSON.stringify({done,total:queue.length}));
}}));
results.sort((a,b)=>a.waiqi_company_id-b.waiqi_company_id);await fs.writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));const summary={companies:results.length,states:results.reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{}),policy:'Company/career pages and observed interface definitions only. Platform hints do not establish official employer identity or list completeness.'};await fs.writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
