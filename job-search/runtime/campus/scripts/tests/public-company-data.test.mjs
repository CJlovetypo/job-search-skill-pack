import './context.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {publicCompanyRecords,publicUrl,publicCompatibility} from '../../../../../shared/job-search-core/scripts/lib/public-company-data.mjs';
test('publication retains usable decisions and strips research even when nested',()=>{
 const input={schema_version:1,generated_at:'2026-09-25',companies:[{company_id:'sample',identity:{company_id:'sample',display_name:'合成公司',private_note:'secret'},tags:{ownership:'国企',industry:['internet'],business:['游戏'],recruitment:{campus:{cities:['北京'],raw_response:'secret'}}},descriptions:{business_summary:'合成公司业务',raw_response:'secret'},research_candidates:{value:'secret'},sources:[{url:'https://example.com/jobs',verification:{raw:'secret'}}],governance:{fields:{'tags.ownership':{status:'api_supported',origin:'api_search',review_state:'api_supported_unverified',provider:'fixture',checked_at:'2026-09-25',source_record:'D:/private.json',evidence:[{url:'https://example.com/about',title:'公开介绍',note:'PRIVATE ORIGINAL BODY',checked_at:'2026-09-25',raw:'secret'}]}},recruitment:{campus:{city_coverage_complete:true,raw:'secret'}}}}]};
 const result=publicCompanyRecords(input),row=result.companies[0];
 assert.equal(row.tags.ownership,'国企');assert.equal(row.descriptions.business_summary,'合成公司业务');assert.equal(row.governance.fields['tags.ownership'].status,'api_supported');
 assert.equal(row.governance.fields['tags.ownership'].evidence[0].url,'https://example.com/about');
 assert(!JSON.stringify(result).includes('secret'));assert(!JSON.stringify(result).includes('PRIVATE ORIGINAL BODY'));assert(!JSON.stringify(result).includes('source_record'));
 assert.deepEqual(publicCompanyRecords(result),result);
});
test('private URLs and compatibility classification history cannot escape publication',()=>{
 for(const url of ['https://example.com/?token=secret','https://user:pass@example.com','https://app.notion.com/private','file:///D:/secret'])assert.equal(publicUrl(url),null);
 assert.equal(publicUrl('https://jobs.feishu.cn/campus'),'https://jobs.feishu.cn/campus');
 const result=publicCompatibility('ownership',{companies:[{company_id:'x',ownership_tag:'外企',status:'api_supported',classification_history:[{secret:true}],evidence:[]}]});
 assert.equal(result.companies[0].ownership_tag,'外企');assert(!JSON.stringify(result).includes('classification_history'));
});
