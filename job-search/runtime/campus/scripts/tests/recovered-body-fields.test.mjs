import './context.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeOracleNowcoder} from '../lib/providers-oracle-nowcoder.mjs';import {splitCommonBody} from '../lib/providers-common.mjs';
const source={provider:'oracle_recruiting',company_id:'fixture',display_name:'测试',api_config:{origin:'https://example.invalid',site:'CX_1'}};
test('Oracle distinct responsibilities and qualifications fields retain real full JD',()=>{
 const j=normalizeOracleNowcoder({Id:'123',Title:'Graduate Engineer',ExternalDescriptionStr:'About the engineering department.',ExternalResponsibilitiesStr:'Design and develop production systems with engineering teams.',ExternalQualificationsStr:'Master degree in engineering and knowledge of software development.',PrimaryLocation:'Shanghai'},source,{});
 assert(j.body_complete);assert.match(j.description,/Design and develop/);assert.match(j.requirements,/Master degree/);assert.deepEqual(j.raw_metadata.body_fields,['ExternalDescriptionStr','ExternalResponsibilitiesStr','ExternalQualificationsStr']);
});
test('Oracle training goals and open-position placeholders do not become full JDs',()=>{
 for(const fields of [{ExternalResponsibilitiesStr:'Support technical analysis and development with engineering teams.',ExternalQualificationsStr:'Learning Objectives\nLearn about production systems and our inclusive culture.'},{ExternalResponsibilitiesStr:'Open location, open position.',ExternalQualificationsStr:'Open location, open position.'}])assert.equal(normalizeOracleNowcoder({Id:'1',Title:'Talent Pool',...fields},source,{}).body_complete,false);
});
test('explicit applicant-condition headings separate requirements without matching casual inline if-you prose',()=>{
 for(const heading of ['如果你是：','如果你：','我们需要你：','我们期待这样的你：']){const p=splitCommonBody('岗位职责：负责产品需求调研和方案设计，与工程团队协作完成项目交付。\n'+heading+'\n2027届应届毕业生，本科及以上学历，具备良好沟通能力。');assert(p.body_complete);assert.match(p.requirements,/2027届应届毕业生/);}
 assert.equal(splitCommonBody('岗位职责：负责软件开发，如果你有兴趣可以联系我们了解团队文化和工作方式。').body_complete,false);
});
