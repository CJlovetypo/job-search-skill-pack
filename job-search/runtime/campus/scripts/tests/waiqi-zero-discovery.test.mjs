import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {extractCareerLinks,atsConfiguration} from '../../../../../shared/job-search-core/scripts/discover-waiqi-zero-websites.mjs';
import {cleanConfiguration} from '../../../../../shared/job-search-core/scripts/verify-waiqi-zero-official.mjs';

test('embedded ATS URLs decode numeric HTML entities without retaining analytics JSON',()=>{
  const html='{"url":"https://accenture.wd103.myworkdayjobs.com/AccentureCareers/userHome&#34;,&#34;analytics-link-name&#34;:&#34;apply&#34;}';
  const links=extractCareerLinks('https://www.accenture.cn/careers',html);
  assert.equal(links[0].url,'https://accenture.wd103.myworkdayjobs.com/AccentureCareers/userHome');
  assert.equal(atsConfiguration(links[0].url).api_config.site,'AccentureCareers');
});

test('strict Workday parsing rejects generic and specialty job paths',()=>{
  assert.equal(atsConfiguration('https://cibc.wd3.myworkdayjobs.com/search/job/Toronto/X')?.provider,undefined);
  const rejected=cleanConfiguration({provider:'workday',entry_url:'https://driscolls.wd5.myworkdayjobs.com/Open_Application/job/Open-Application_R1'});
  assert.equal(rejected.error,'specialty_or_generic_workday_job_path_is_not_a_canonical_site');
});

test('reviewed Workday job links resolve to a canonical site root',()=>{
  const result=cleanConfiguration({provider:'workday',entry_url:'https://driscolls.wd5.myworkdayjobs.com/driscolls/job/City/Role_R1/apply'});
  assert.equal(result.parsed.api_config.site,'driscolls');
  assert.equal(result.parsed.entry_url,'https://driscolls.wd5.myworkdayjobs.com/en-US/driscolls');
  assert.equal(result.parsed.observed_entry_url,'https://driscolls.wd5.myworkdayjobs.com/driscolls/job/City/Role_R1/apply');
});
