import './context.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {collectEndpoint,collectCompanySources,sourceConfigFingerprint,sourceCacheMatches} from '../../../../../shared/job-search-core/scripts/lib/source-collector.mjs';
import {collectTargeted} from '../../../../../shared/job-search-core/scripts/lib/collect-targeted.mjs';
const bad={company_id:'c',display_name:'Expected employer',source_id:'s',provider:'unconfigured',primary_entry_url:'https://example.org/jobs',identity_verification:{identity_verified:false,basis:'Different employer confirmed'}};
test('explicit failed identity stops endpoint, exhaustive and targeted collection before network',async()=>{
 for(const result of [await collectEndpoint(bad),await collectCompanySources({...bad,recruitment_sources:[bad]}),await collectTargeted({...bad,recruitment_sources:[bad]},{mode:'targeted',company_ids:['c'],keywords:['Engineer'],exclude_keywords:[]})]){
  assert.equal(result.jobs.length,0);assert.equal(result.requests.length,0);assert.equal(result.coverage.status,'failed');assert.match(result.coverage.reason,/source_identity_not_verified/);
 }
});
test('identity correction invalidates cached company results',()=>{
 const before={...bad,identity_verification:{identity_verified:true}},after={...bad};
 assert.notEqual(sourceConfigFingerprint(before),sourceConfigFingerprint(after));assert.equal(sourceCacheMatches({source_config_fingerprint:sourceConfigFingerprint(before)},after),false);
});
