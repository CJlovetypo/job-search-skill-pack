import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeWorkday} from '../../../../../shared/job-search-core/scripts/lib/providers-international.mjs';

const source={company_id:'fixture',display_name:'Fixture'};
function normalize(body){return normalizeWorkday({jobPostingInfo:{jobReqId:'REQ-1',title:'Intern, Financial Market Sales',location:'Shanghai',country:{descriptor:'China'},canApply:true,jobDescription:body}},source,{response_file:'/fixture.json'});}
test('Workday ING qualities-and-skills heading separates real eligibility from responsibilities',()=>{
 const job=normalize('<p>What will you be doing?</p><p>Conduct market research and prepare client presentations while supporting financial markets sales.</p><p>What qualities and skills are we looking for?</p><p>Currently pursuing a university degree in finance or economics, with strong English and Chinese communication skills.</p>');
 assert.equal(job.body_complete,true);
 assert.match(job.requirements,/Currently pursuing a university degree/);
 assert.doesNotMatch(job.requirements,/Conduct market research/);
 assert.equal(job.formal_status,'internship');
});
test('a qualities-and-skills heading without eligibility text does not establish a complete JD',()=>{
 assert.equal(normalize('<p>Conduct market research and prepare client presentations while supporting sales.</p><p>What qualities and skills are we looking for?</p>').body_complete,false);
});
test('candidate and education headings preserve published eligibility requirements',()=>{
 for(const heading of ['ABOUT THE CANDIDATE','Education and Experience Requirements 教育和经验要求']){
  const job=normalize('<p>Responsibilities: design production tools and support manufacturing process improvements.</p><p>'+heading+'</p><p>Bachelor degree in engineering and three years of manufacturing experience.</p>');
  assert.equal(job.body_complete,true);
  assert.match(job.requirements,/Bachelor degree/);
  assert.doesNotMatch(job.requirements,/design production tools/);
 }
 assert.equal(normalize('<p>Help us build a better future. Register for alerts about future opportunities.</p>').body_complete,false);
});
