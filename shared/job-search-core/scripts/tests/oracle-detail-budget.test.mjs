import test from 'node:test';
import assert from 'node:assert/strict';
import {collectOracleNowcoder} from '../lib/providers-oracle-nowcoder.mjs';

const source={company_id:'oracle-test',display_name:'Oracle fixture',provider:'oracle_recruiting',api_config:{origin:'https://oracle.example',site:'CX'}};
const rows=Array.from({length:5},(_,i)=>({Id:String(i+1),Title:'Software engineer',PrimaryLocation:'Shanghai',PrimaryLocationCountry:'CN'}));
function fixture({failDetail=false}={}){
  const client={records:[],async request(q,{purpose}){
    const record={http_status:200,purpose,response_file:purpose==='job_detail'?'detail.json':'list.json'};client.records.push(record);
    if(purpose==='job_detail'){
      if(failDetail)throw Error('detail service unavailable');
      const id=decodeURIComponent(q.url).match(/Id="([^"]+)"/)[1];
      return {record,data:{items:[{...rows.find(r=>r.Id===id),ExternalResponsibilitiesStr:'Design and build reliable software services. Work with engineers to deliver useful products.',ExternalQualificationsStr:'A degree in computer science and three years of relevant software development experience are required.'}]}};
    }
    return {record,data:{items:[{TotalJobsCount:rows.length,requisitionList:rows}]}};
  }};
  return client;
}

test('Oracle detail cap preserves every list row without recording skipped details as failures',async()=>{
  const client=fixture(),result=await collectOracleNowcoder(source,{client,mode:'full',maxPages:1,maxDetails:2,detailConcurrency:4});
  assert.equal(client.records.filter(r=>r.purpose==='job_detail').length,2);
  assert.equal(result.jobs.length,5);
  assert.equal(result.jobs.filter(j=>j.detail_skipped_reason==='detail_limit').length,3);
  assert.equal(result.coverage.list_complete,true);
  assert.equal(result.coverage.status,'partial');
  assert.equal(result.coverage.details_requested,2);
  assert.equal(result.coverage.details_skipped_limit,3);
  assert.equal(result.coverage.details_failed,0);
  assert.equal(result.coverage.required_incomplete_bodies,0);
  assert.ok(result.jobs.filter(j=>j.detail_skipped_reason).every(j=>!j.raw_metadata.detail_fetch_error));
});

test('Oracle zero detail cap performs no detail requests, while omitted cap retains full collection',async()=>{
  for(const cap of [0,undefined]){
    const client=fixture(),result=await collectOracleNowcoder(source,{client,mode:'full',maxPages:1,maxDetails:cap});
    assert.equal(client.records.filter(r=>r.purpose==='job_detail').length,cap===0?0:5);
    assert.equal(result.jobs.length,5);
    assert.equal(result.coverage.details_failed,0);
    assert.equal(result.coverage.details_skipped_limit,cap===0?5:0);
  }
});

test('Oracle real detail failures remain failures and consume the attempt limit',async()=>{
  const client=fixture({failDetail:true}),result=await collectOracleNowcoder(source,{client,mode:'full',maxPages:1,maxDetails:1,detailConcurrency:3});
  assert.equal(result.coverage.details_requested,1);
  assert.equal(result.coverage.details_failed,1);
  assert.equal(result.coverage.details_skipped_limit,4);
  assert.equal(result.jobs.length,5);
  assert.equal(result.jobs.filter(j=>j.raw_metadata.detail_fetch_error).length,1);
});
