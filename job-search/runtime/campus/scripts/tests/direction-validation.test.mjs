import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {directionSourceKey,validatedDirectionRegistry,DIRECTION_VALIDATION_POLICY} from '../lib/direction-validation.mjs';
const c={company_id:'C',display_name:'测试主体',recruitment_sources:[{source_id:'one',provider:'beisen',primary_entry_url:'https://example.test/a'},{source_id:'two',provider:'moka',primary_entry_url:'https://example.test/b'},{source_id:'three',provider:'hotjob'}]};
const rows=c.recruitment_sources.map((s,i)=>({key:directionSourceKey(c,s,i),enabled:true}));
const validation={schema_version:1,policy_version:DIRECTION_VALIDATION_POLICY,mode:'internship',configurations:[{...rows[0],status:'verified_current_target',proof:{accepted:true}},{...rows[1],status:'verified_direction_endpoint',proof:{accepted:false},endpoint_proof:{accepted:true}},{...rows[2],status:'request_failed',enabled:false,proof:{accepted:false}}]};
test('有JD、仅有明确接口、证据不足和旧停用记录均启用，证据分开计数',()=>{
 const r=validatedDirectionRegistry([c],validation,'internship');assert.deepEqual(r.companies,[c]);assert.equal(r.enabled_configurations,3);assert.equal(r.disabled_configurations,0);assert.equal(r.current_jd_verified_configurations,1);assert.equal(r.endpoint_confirmed_configurations,1);assert.equal(r.unverified_configurations,1);
});
test('变更配置或缺少证据仍然启用，但不继承旧通过状态',()=>{
 const changed=structuredClone(c);changed.recruitment_sources[0].primary_entry_url='https://other.test/a';
 const r=validatedDirectionRegistry([changed],validation,'internship');assert.equal(r.enabled_configurations,3);assert.equal(r.current_jd_verified_configurations,0);assert.equal(r.unverified_configurations,2);
 for(const v of [null,{...validation,mode:'social'},{...validation,policy_version:'old'}]){const x=validatedDirectionRegistry([c],v,'internship');assert.equal(x.enabled_configurations,3);assert.equal(x.unverified_configurations,3);}
 const duplicate={...validation,configurations:[...validation.configurations,validation.configurations[0]]};assert.equal(validatedDirectionRegistry([c],duplicate,'internship').unverified_configurations,2);
 assert.deepEqual(validatedDirectionRegistry([c],null,'campus').companies,[c]);
});
