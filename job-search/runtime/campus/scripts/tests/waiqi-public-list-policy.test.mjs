import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {publicListCandidateProblem} from '../../../../../shared/job-search-core/scripts/lib/public-list-source-policy.mjs';

const sha='a'.repeat(64);
function candidate(provider,api_config,url,entry='https://careers.example.test/') {
  return {
    provider,api_config,primary_entry_url:entry,admitted:true,
    verification_status:'verified_public_list_only',
    validated_api_request_examples:[{url,method:'GET',purpose:'job_list'}],
    identity_verification:{identity_verified:true,official_name:'Example',evidence_file:'/proof/identity.html',basis:'official entry'},
    source_verification:{complete_jd_samples:0,observed_jobs:2,proof_directory:'/proof',identity_basis:'official entry',public_list_capability:{
      anonymous:true,list_complete:true,jobs_observed:2,request_evidence:[{url,method:'GET',http_status:200,response_file:'/proof/list.json',response_sha256:sha,anonymous_session_from_scratch:true}],
    }},
  };
}

test('reviewed standard ATS list routes are admitted without JD evidence',()=>{
  const fixtures=[
    ['workday',{origin:'https://acme.wd5.myworkdayjobs.com',tenant:'acme',site:'Careers'},'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs'],
    ['oracle_recruiting',{origin:'https://acme.fa.oraclecloud.com',site:'External'},'https://acme.fa.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?finder=findReqs%3BsiteNumber%3DExternal%2CfacetsList%3DNONE'],
    ['smartrecruiters',{company_identifier:'Acme'},'https://api.smartrecruiters.com/v1/companies/Acme/postings'],
    ['greenhouse',{board_token:'acme'},'https://boards-api.greenhouse.io/v1/boards/acme/jobs'],
    ['ashby',{board_token:'acme'},'https://api.ashbyhq.com/posting-api/job-board/acme'],
    ['tupu360',{origin:'https://acme.tupu360.com'},'https://acme.tupu360.com/positionData/listInfo?type=SOCIALRECRUITMENT&offset=0&max=200&lang=zh_CN'],
    ['beisen',{},'https://acme.zhiye.com/api/Jobad/GetJobAdPageList'],
    ['moka',{},'https://acme.jobs.feishu.cn/api/outer/ats-apply/website/jobs/v2'],
    ['feishu',{},'https://acme.jobs.feishu.cn/api/v1/search/job/posts'],
    ['hotjob',{},'https://acme.hotjob.cn/wecruit/positionInfo/listPosition/SUabc'],
  ];
  for(const [provider,config,url] of fixtures)assert.equal(publicListCandidateProblem(candidate(provider,config,url)),null,provider);
});

test('a detail route or a list route outside the reviewed source is rejected',()=>{
  const good=candidate('greenhouse',{board_token:'acme'},'https://boards-api.greenhouse.io/v1/boards/acme/jobs');
  assert.match(publicListCandidateProblem({...good,source_verification:{...good.source_verification,public_list_capability:{...good.source_verification.public_list_capability,request_evidence:[{...good.source_verification.public_list_capability.request_evidence[0],url:'https://boards-api.greenhouse.io/v1/boards/other/jobs'}]}}}),/scope mismatch/);
  const detail=candidate('feishu',{},'https://acme.jobs.feishu.cn/api/v1/job/posts/123');
  assert.match(publicListCandidateProblem(detail),/scope mismatch/);
});
