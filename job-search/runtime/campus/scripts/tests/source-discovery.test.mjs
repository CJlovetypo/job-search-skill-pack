import './context.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {sourceFromEntry} from '../source-discovery.mjs';
test('source discovery retains Moka tenant and site and uses only public request templates',()=>{
 const s=sourceFromEntry({company_id:'fixture',display_name:'合成公司'},'https://example.test/campus-recruitment/observed-org/123?access_token=secret');
 assert.equal(s.provider,'moka');assert.equal(s.validated_api_request_examples[0].body.orgId,'observed-org');assert.equal(s.validated_api_request_examples[0].body.siteId,'123');assert(!s.primary_entry_url.includes('secret'));
});
test('capability fallback broadens recruitment query without labeling it formal by assumption',()=>{
 const item={display_name:'合成测试'};const campus=sourceFromEntry(item,'https://fixture.zhiye.com/campus/jobs'),broad=sourceFromEntry(item,'https://fixture.zhiye.com/campus/jobs',{allTypes:true});
 assert.deepEqual(campus.validated_api_request_examples[0].body.Category,['2']);assert.deepEqual(broad.validated_api_request_examples[0].body.Category,[]);
 assert.throws(()=>sourceFromEntry(item,'https://example.test/unknown'),/No supported ATS/);
});
