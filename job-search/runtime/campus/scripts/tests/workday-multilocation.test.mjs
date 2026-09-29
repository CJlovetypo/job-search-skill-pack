import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectInternational,isWorkdayMainlandDetail} from '../../../../../shared/job-search-core/scripts/lib/providers-international.mjs';

test('mainland requisition country admits a multi-location job without accepting foreign-only or HK/TW locations',async()=>{
 const detail={jobPostingInfo:{jobReqId:'REQ1',title:'Engineer',country:{descriptor:'Philippines'},location:'Manila',additionalLocations:['Shanghai'],jobRequisitionLocation:{country:{descriptor:'China'}},externalUrl:'https://example.invalid/jobs/REQ1',canApply:true,jobDescription:'Responsibilities\nDesign production tools and support manufacturing process improvements.\nRequirements\nBachelor degree in engineering and three years of manufacturing experience.'}};
 const records=[],client={records,async request(q,meta){const record={http_status:200,response_file:'synthetic-'+records.length,purpose:meta.purpose};records.push(record);return{record,data:q.method==='POST'?{total:1,facets:[{facetParameter:'locationCountry',values:[{id:'cn',descriptor:'China'}]}],jobPostings:[{externalPath:'/job/Engineer_REQ1',title:'Engineer',bulletFields:['REQ1']}]}:detail};}};
 const result=await collectInternational({provider:'workday',company_id:'fixture',display_name:'Fixture',api_config:{origin:'https://example.invalid',tenant:'fixture',site:'careers'}},{client});
 assert.equal(result.jobs.length,1);assert.equal(result.coverage.status,'complete');assert.equal(result.coverage.excluded_country_rows.length,0);
 assert.deepEqual(result.jobs[0].locations_raw,['Manila','Shanghai']);assert.ok(result.jobs[0].cities.includes('上海'));
 for(const descriptor of ['Philippines','Hong Kong','Taiwan',undefined]){
  const other=structuredClone(detail);other.jobPostingInfo.jobRequisitionLocation.country.descriptor=descriptor;
  assert.equal(isWorkdayMainlandDetail(other),false);
 }
});
