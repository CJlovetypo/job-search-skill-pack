import test from 'node:test';
import assert from 'node:assert/strict';
import {projectCompanyRecords} from '../lib/company-records.mjs';

test('description classification replaces stale compatibility tags without claiming verification',()=>{
 const meta={origin:'local_description_classification',status:'demo_unreviewed',evidence:[]};
 const record={company_id:'example',identity:{display_name:'Example'},tags:{industry:['supply_chain'],business:['芯片']},descriptions:{business_summary:'Chip products'},governance:{fields:{'tags.industry':meta,'tags.business':meta,'tags.ownership':{},'tags.organization_size':{},'descriptions.business_summary':{origin:'baseline'}}}};
 const inputs={registry:{companies:[{company_id:'example',display_name:'Example',industry_tags:['smart_hardware']}]},business:{companies:[{company_id:'example',business_tags:['智能硬件']}]},ownership:{companies:[]},profiles:{companies:[]}};
 const result=projectCompanyRecords({companies:[record]},inputs);
 assert.deepEqual(result.registry.companies[0].industry_tags,['supply_chain']);
 assert.deepEqual(result.business.companies[0].business_tags,['芯片']);
 assert.equal(result.business.companies[0].status,'demo_unreviewed');
 assert.deepEqual(inputs.registry.companies[0].industry_tags,['smart_hardware']);
});
