import './context.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {directionSources} from '../../../../../shared/job-search-core/scripts/lib/source-directions.mjs';
test('audit pins discovery inside one comparison while new comparisons discover afresh',async()=>{
 let calls=0;const client={records:[],async request(){calls++;return {url:'https://fixture.example/campus',text:'<script id="js-websiteInfo">{"website_info":{"path":"campus"}}</script>',record:{http_status:200}};}};
 const source={provider:'feishu',primary_entry_url:'https://fixture.example/campus',validated_api_request_examples:[]},opts={targetMode:'social',refresh:true,discoveryClient:client,directionDiscoveryMemo:new Map()};
 const first=await directionSources(source,opts);first.plan.limitation='mutated caller';const second=await directionSources(source,opts);
 assert.equal(calls,1);assert.match(second.plan.limitation,/校招/);assert.equal(second.sources.length,1);
 await directionSources(source,{...opts,directionDiscoveryMemo:new Map()});assert.equal(calls,2);
});
