import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {directionSources,routeKnownSource,requestObject} from '../lib/source-directions.mjs';

// Offline synthetic source configurations, not live API-verification evidence.
const fixture=body=>({provider:'hotjob',company_id:'synthetic-company',source_id:'synthetic-source',primary_entry_url:'https://fixture.invalid/SU123/mc/position/campus',validated_api_request_examples:[
 {url:'https://fixture.invalid/wecruit/positionInfo/listPosition/SU123?request_locale=zh_CN',method:'POST',headers:{Referer:'https://fixture.invalid/SU123/mc/position/campus'},body},
 {url:'https://fixture.invalid/wecruit/positionInfo/listPositionDetail/SU123?request_locale=zh_CN',method:'POST',body:null},
]});
const type=source=>String(requestObject(source.validated_api_request_examples[0]).recruitType);

test('Hotjob internship queries documented type12 before campus1 and social2',async()=>{
 for(const original of ['1','2','12'])for(const preferTargetTypes of [false,true]){
  const source=fixture(`orgId=keep&recruitType=${original}&pageSize=3&currentPage=1`),before=structuredClone(source);
  const routed=await directionSources(source,{targetMode:'internship',preferTargetTypes});
  assert.deepEqual(routed.sources.map(type),['12','1','2']);
  assert.deepEqual(source,before);assert.deepEqual(routed.requests,[]);
  assert.equal(routed.plan.scope,'validate_target_at_runtime');
  for(const s of routed.sources){
   assert.equal(s.target_mode,'internship');assert.equal(s.company_id,source.company_id);assert.equal(s.source_id,source.source_id);
   assert.equal(requestObject(s.validated_api_request_examples[0]).orgId,'keep');
   assert.equal(requestObject(s.validated_api_request_examples[0]).pageSize,'3');
   assert.deepEqual(s.validated_api_request_examples[1],source.validated_api_request_examples[1]);
   assert.equal(s.validated_api_request_examples[0].url,source.validated_api_request_examples[0].url);
   assert.deepEqual(s.validated_api_request_examples[0].headers,source.validated_api_request_examples[0].headers);
   assert.equal(s.formal_status,undefined);assert.equal(s.recruitment_evidence,undefined);
  }
 }
});
test('Hotjob routing supports object request bodies and changes only the selected type',()=>{
 const source=fixture({recruitType:1,pageSize:3,keyword:'工程师',projectId:'verified-project'}),before=structuredClone(source);
 const s=routeKnownSource(source,'internship');
 assert.deepEqual(requestObject(s.validated_api_request_examples[0]),{recruitType:'12',pageSize:'3',keyword:'工程师',projectId:'verified-project'});
 assert.deepEqual(source,before);
});
test('Hotjob social uses only type2 and campus retains the original source unchanged',async()=>{
 const source=fixture('orgId=keep&recruitType=1');
 const social=await directionSources(source,{targetMode:'social'});assert.deepEqual(social.sources.map(type),['2']);
 const campus=await directionSources(source,{targetMode:'campus'});assert.deepEqual(campus.sources,[source]);assert.equal(campus.sources[0],source);
});
