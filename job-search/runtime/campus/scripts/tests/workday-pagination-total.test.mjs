import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectInternational} from '../../../../../shared/job-search-core/scripts/lib/providers-international.mjs';

async function collect(lastPage){
 const records=[],offsets=[],client={records,async request(q,meta){
  const record={http_status:200,response_file:'synthetic-'+records.length,purpose:meta.purpose};records.push(record);
  if(meta.purpose==='public_country_facet_discovery')return{record,data:{total:3,facets:[{facetParameter:'locationCountry',values:[{id:'cn',descriptor:'China'}]}]}};
  if(q.method==='POST'){offsets.push(q.body.offset);assert.ok(offsets.length<=2,'must stop after reconciling first-page total');const p=q.body.offset?lastPage:{total:3,ids:['a','b']};return{record,data:{total:p.total,jobPostings:p.ids.map(id=>({externalPath:'/job/'+id,bulletFields:[id],title:'Engineer'}))}};}
  const id=q.url.split('/').at(-1);return{record,data:{jobPostingInfo:{jobReqId:id,country:{descriptor:'China'},title:'Engineer',externalUrl:'https://example.invalid/job/'+id,jobDescription:'Responsibilities\nDesign production tools and support manufacturing process improvements.\nRequirements\nBachelor degree in engineering and three years of manufacturing experience.'}}};
 }};
 return{offsets,result:await collectInternational({provider:'workday',company_id:'fixture',api_config:{origin:'https://example.invalid',tenant:'fixture',site:'careers'}},{client,maxPages:2})};
}
test('Workday later-page zero count with rows reconciles the original total',async()=>{
 const {result,offsets}=await collect({total:0,ids:['c']});
 assert.deepEqual(offsets,[0,2]);assert.equal(result.jobs.length,3);assert.equal(result.coverage.list_complete,true);assert.equal(result.coverage.status,'complete');
 assert.equal(result.coverage.server_total,3);assert.equal(result.coverage.page_evidence[1].reported_server_total,0);
});
test('Workday empty pages, real total changes and duplicate IDs remain incomplete',async()=>{
 for(const page of [{total:0,ids:[]},{total:4,ids:['c']},{total:0,ids:['b']}]){
  const {result}=await collect(page);assert.equal(result.coverage.list_complete,false);assert.equal(result.coverage.status,'partial');
 }
});
