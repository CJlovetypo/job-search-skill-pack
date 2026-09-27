import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {apiListContractCandidateProblem} from '../../../../../shared/job-search-core/scripts/lib/api-list-contract-source-policy.mjs';
import {planWaiqiIntegration} from '../../../../../shared/job-search-core/scripts/lib/waiqi-integration.mjs';

const endpoint='https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs';
const candidate={company_id:'acme',display_name:'Acme',provider:'workday',api_config:{origin:'https://acme.wd5.myworkdayjobs.com',tenant:'acme',site:'Careers'},primary_entry_url:'https://acme.wd5.myworkdayjobs.com/Careers',industry_tags:['internet'],admitted:true,verification_status:'verified_api_list_contract',verified_at:'2026-09-21T00:00:00Z',validated_api_request_examples:[{url:endpoint,method:'POST',body:{appliedFacets:{},limit:20,offset:0},purpose:'job_list'}],identity_verification:{identity_verified:true,official_name:'Acme',evidence_file:'/proof/company.html',basis:'official chain'},source_verification:{complete_jd_samples:0,observed_jobs:20,proof_directory:'/proof',identity_basis:'official chain',api_list_contract:{anonymous:true,endpoint_verified:true,list_complete:false,jobs_observed:20,reason:'inventory changed during pagination',request_evidence:[{url:endpoint,method:'POST',http_status:200,response_is_json:true,response_file:'/proof/list.json',response_sha256:'a'.repeat(64),anonymous_session_from_scratch:true}]}}};

test('a live anonymous list contract can be registered when a changing inventory prevents a complete snapshot',()=>{
  assert.equal(apiListContractCandidateProblem(candidate),null);
  const plan=planWaiqiIntegration({companies:[]},[{item:candidate,file:'/proof/admitted.json'}],['internet']);
  assert.equal(plan.added.length,1);
  assert.equal(plan.registry.companies[0].verification_status,'verified_api_list_contract');
});

test('list-contract admission still rejects detail routes, credentials and failed requests',()=>{
  for(const change of [c=>c.source_verification.api_list_contract.request_evidence[0].url='https://acme.wd5.myworkdayjobs.com/Careers/job/Shanghai/Role_1',c=>c.source_verification.api_list_contract.request_evidence[0].headers={Authorization:'Bearer x'},c=>c.source_verification.api_list_contract.request_evidence[0].http_status=500]){const copy=structuredClone(candidate);change(copy);assert.ok(apiListContractCandidateProblem(copy));}
});
