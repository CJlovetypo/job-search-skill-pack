import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {companyNameMatches,interfaceMatchesUrl} from '../../../../../shared/job-search-core/scripts/lib/waiqi-interface-identity.mjs';

test('Waiqi outside job URLs bind to the exact ATS tenant and site',()=>{
  assert.equal(interfaceMatchesUrl({provider:'workday',entry_url:'https://acme.wd5.myworkdayjobs.com/Careers',api_config:{origin:'https://acme.wd5.myworkdayjobs.com',site:'Careers'}},'https://acme.wd5.myworkdayjobs.com/Careers/job/Shanghai/Role_1'),true);
  assert.equal(interfaceMatchesUrl({provider:'workday',entry_url:'https://acme.wd5.myworkdayjobs.com/Other',api_config:{origin:'https://acme.wd5.myworkdayjobs.com',site:'Other'}},'https://acme.wd5.myworkdayjobs.com/Careers/job/Shanghai/Role_1'),false);
  assert.equal(interfaceMatchesUrl({provider:'workday',entry_url:'https://wd1.myworkdaysite.com/recruiting/acme/Careers',api_config:{origin:'https://wd1.myworkdaysite.com',tenant:'acme',site:'Careers'}},'https://wd1.myworkdaysite.com/recruiting/acme/Careers/job/Shanghai/Role_1'),true);
  assert.equal(interfaceMatchesUrl({provider:'oracle_recruiting',entry_url:'https://acme.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1',api_config:{origin:'https://acme.oraclecloud.com',site:'CX_1'}},'https://acme.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/42'),true);
  assert.equal(interfaceMatchesUrl({provider:'oracle_recruiting',entry_url:'https://acme.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1',api_config:{origin:'https://acme.oraclecloud.com',site:'CX_1'}},'https://acme.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1'),true);
  assert.equal(interfaceMatchesUrl({provider:'smartrecruiters',entry_url:'https://careers.smartrecruiters.com/Acme',api_config:{company_identifier:'Acme'}},'https://careers.smartrecruiters.com/Acme'),true);
  assert.equal(interfaceMatchesUrl({provider:'ashby',entry_url:'https://jobs.ashbyhq.com/Jasper%20AI',api_config:{board_token:'Jasper AI'}},'https://jobs.ashbyhq.com/Jasper%20AI/123'),true);
  assert.equal(interfaceMatchesUrl({provider:'ashby',entry_url:'https://jobs.ashbyhq.com/notion',api_config:{board_token:'notion'}},'https://jobs.ashbyhq.com/replit/123'),false);
  assert.equal(interfaceMatchesUrl({provider:'moka',entry_url:'https://app.mokahr.com/social-recruitment/acme/42',api_config:{}},'https://app.mokahr.com/social-recruitment/acme/42#/job/1'),true);
  assert.equal(interfaceMatchesUrl({provider:'moka',entry_url:'https://app.mokahr.com/social-recruitment/acme/42',api_config:{}},'https://app.mokahr.com/social-recruitment/other/42#/job/1'),false);
});

test('Waiqi list company name must match a reviewed display name or alias',()=>{
  const company={display_name:'培生集团有限公司',aliases:['Pearson plc 培生','Pearson plc']};
  assert.equal(companyNameMatches(company,'Pearson'),true);
  assert.equal(companyNameMatches(company,'Another Employer'),false);
});
