import './context.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {smartRecruitersOpenStatus,additionalRequirements} from '../lib/normalization-additions.mjs';
import {mainlandLocationQueries} from '../lib/workday-mainland-facets.mjs';
import {collectWorkdayLocationFallback} from '../lib/workday-location-fallback.mjs';
test('explicit inactive or internal SmartRecruiters detail cannot become open through posting URL',()=>{
 assert.equal(smartRecruitersOpenStatus({postingUrl:'https://example.invalid/j/1',active:false,visibility:'INTERNAL'},true),'closed');
 assert.equal(smartRecruitersOpenStatus({postingUrl:'https://example.invalid/j/1',active:true,visibility:'INTERNAL'},true),'closed');
 assert.equal(smartRecruitersOpenStatus({postingUrl:'https://example.invalid/j/1',active:true,visibility:'PUBLIC'}),'open');
 assert.equal(smartRecruitersOpenStatus({postingUrl:'https://example.invalid/j/1'}),'unknown');
});
test('all supported nested mainland locations are discovered, foreign and HK labels excluded',()=>{
 const g=mainlandLocationQueries([{facetParameter:'locationMainGroup',values:[{facetParameter:'locations',values:[{id:'s',descriptor:'Pudong, Shanghai'},{id:'b',descriptor:'Beijing (Kewei)'},{id:'h',descriptor:'Hong Kong'},{id:'t',descriptor:'Taipei, Taiwan'},{id:'f',descriptor:'Singapore'}]},{facetParameter:'locationHierarchy2',values:[{id:'r',descriptor:'China - Remote'},{id:'p',descriptor:'Jiangsu'},{id:'x',descriptor:'Texas'}]}]}]);
 assert.deepEqual(g.map(x=>[x.field,x.values.map(v=>v.id)]),[['locations',['s','b']],['locationHierarchy2',['r','p']]]);
});
test('fallback enumerates all pages for every discovered location query and deduplicates overlap',async()=>{
 const records=[],body='Responsibilities\nDesign and review internal systems and documents, and work with colleagues to deliver projects.\nRequirements\nBachelor degree in a relevant discipline and strong communication and analytical skills.';
 const client={records,async request(q,meta){const record={http_status:200,response_file:'synthetic-'+records.length,purpose:meta.purpose};records.push(record);let data;if(q.method==='POST'&&!Object.keys(q.body.appliedFacets).length)data={total:3,facets:[{facetParameter:'locations',values:[{id:'s',descriptor:'Shanghai'}]},{facetParameter:'locationHierarchy2',values:[{id:'p',descriptor:'Jiangsu'}]}],jobPostings:[]};else if(q.method==='POST'){const secondary=!!q.body.appliedFacets.locationHierarchy2;const ids=secondary?['b','foreign']:q.body.offset?['b']:['a'];data={total:2,jobPostings:ids.map(id=>({externalPath:'/job/'+id,title:id,bulletFields:[id]}))};}else{const id=q.url.split('/').at(-1);data={jobPostingInfo:{jobReqId:id,title:'Engineer',jobDescription:body,location:id==='foreign'?'Singapore':'Shanghai',country:{descriptor:id==='foreign'?'Singapore':'China'},externalUrl:'https://example.invalid/jobs/'+id,canApply:true}};}return{data,record};}};
 const r=await collectWorkdayLocationFallback({provider:'workday',company_id:'test',display_name:'Test',api_config:{origin:'https://example.invalid',tenant:'test',site:'careers'}},{client,pageSize:1});
 assert.equal(r.coverage.list_complete,true);assert.equal(r.coverage.pages,3);assert.equal(r.coverage.status,'partial');assert.deepEqual(r.jobs.map(x=>x.job_id).sort(),['a','b']);assert.equal(r.coverage.excluded_country_rows.length,1);assert.equal(records.filter(x=>x.purpose==='job_detail').length,3);
});
test('explicit additional requirement boundaries create a real requirement section',()=>{
 for(const marker of ['What you need to have:','Who Can Apply','To be successful in this role you will:','Penultimate year LLM student']){const body='Responsibilities: undertake research, prepare client reports and coordinate delivery with the wider project team.\n'+marker+'\nBachelor or postgraduate degree with analytical reasoning and communication skills.';const p=additionalRequirements(body);assert.ok(p.body_complete);assert.ok(p.requirements.startsWith(marker));}
 assert.equal(additionalRequirements('Assist on legal research, drafting documents and supporting client work. No requirements provided.'),null);
});
test('successful Workday facet discovery with no mainland labels is partial empty coverage, not an API failure',async()=>{
 const records=[],client={records,async request(q,meta){const record={http_status:200,response_file:'synthetic-empty-facets',purpose:meta.purpose};records.push(record);return{record,data:{total:5,jobPostings:[],facets:[{facetParameter:'locations',values:[{id:'uk',descriptor:'London'}]}]}};}};
 const r=await collectWorkdayLocationFallback({provider:'workday',company_id:'test',display_name:'Test',api_config:{origin:'https://example.invalid',tenant:'test',site:'careers'}},{client});
 assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.pages,0);assert.equal(r.jobs.length,0);assert.match(r.coverage.reason,/No supported mainland location labels/);
});
test('later list HTTP failure retains earlier rows and detail processing, clamps oversized page size',async()=>{
 const records=[],limits=[];
 const client={records,async request(q,meta){const record={http_status:200,response_file:'synthetic-'+records.length,purpose:meta.purpose};records.push(record);if(q.method==='POST'){limits.push(q.body.limit);if(q.body.offset){record.http_status=503;return{record,data:{error:'temporarily unavailable'}};}return{record,data:{total:3,jobPostings:[{externalPath:'/job/ok',title:'Engineer',bulletFields:['ok']},{externalPath:'/job/fail',title:'Assistant',bulletFields:['fail']}]}};}if(q.url.endsWith('/fail'))throw Error('detail timeout');return{record,data:{jobPostingInfo:{jobReqId:'ok',title:'Engineer',jobDescription:'Responsibilities\nDesign and review systems and prepare technical reports for engineering teams.\nRequirements\nBachelor degree in engineering with strong analytical and communication skills.',location:'Shanghai',country:{descriptor:'China'},externalUrl:'https://example.invalid/jobs/ok',canApply:true}}};}};
 const r=await collectWorkdayLocationFallback({provider:'workday',company_id:'test',display_name:'Test',api_config:{origin:'https://example.invalid',tenant:'test',site:'careers'}},{client,pageSize:100,bootstrap:{data:{facets:[{facetParameter:'locations',values:[{id:'s',descriptor:'Shanghai'}]}]}}});
 assert.deepEqual(limits,[20,20]);assert.equal(r.jobs.length,2);assert.equal(r.jobs.find(j=>j.job_id==='ok').body_complete,true);assert.equal(r.jobs.find(j=>j.raw_metadata?.observed_external_path==='/job/fail').body_complete,false);assert.equal(r.coverage.details_failed,1);assert.equal(r.coverage.list_complete,false);assert.equal(r.coverage.status,'partial');assert.match(r.coverage.reason,/list_page_failed:locations:2/);
});
