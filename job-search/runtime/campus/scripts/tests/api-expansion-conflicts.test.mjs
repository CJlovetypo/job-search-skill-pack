import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {collectRecovered} from '../../../../../shared/job-search-core/scripts/lib/providers-recovered.mjs';
import {collectEndpoint} from '../../../../../shared/job-search-core/scripts/lib/source-collector.mjs';
import {reviewedEmployerKey,sourceKey} from '../../../../../shared/job-search-core/scripts/lib/waiqi-integration.mjs';

const client=handler=>{const records=[];return {records,async request(q,meta){const value=handler(q),record={http_status:200,response_file:'synthetic.json',purpose:meta.purpose};records.push(record);return {record,data:typeof value==='object'?value:null,text:typeof value==='string'?value:JSON.stringify(value),url:q.url};}};};

test('reviewed global Greenhouse lists work without inventing mainland filtering',async()=>{
  const source={company_id:'fixture',display_name:'Fixture',provider:'greenhouse',verification_status:'verified_public_list_only',api_config:{board_token:'fixture'}};
  const result=await collectRecovered(source,{mode:'list',client:client(()=>({jobs:[{id:1,title:'Engineer',location:{name:'London'},absolute_url:'https://job-boards.greenhouse.io/fixture/jobs/1'}],meta:{total:1}}))});
  assert.equal(result.jobs.length,1);assert.equal(result.coverage.list_complete,true);
  assert.match(result.coverage.scope,/global Greenhouse/);assert.match(result.coverage.scope,/mainland coverage not established/);
  assert.deepEqual(result.coverage.excluded_location_rows,[]);
  await assert.rejects(collectRecovered({...source,verification_status:'verified_api_full_jd'},{mode:'full'}),/observed mainland location pattern/);
});

for(const targetMode of ['campus','internship','social'])test(`list-only runtime keeps full collection partial in ${targetMode}`,async()=>{
  const source={company_id:'fixture',source_id:'fixture-list',display_name:'Fixture',provider:'moseeker_public',primary_entry_url:'https://www.moseeker.com/positions/index/cid/123',api_config:{company_id:'123'}};
  const response='<textarea id="position-data">'+JSON.stringify({companyId:'123',total:1,positions:[{name:'Engineer',href:'/position/index/pid/1',shortCities:'上海'}]})+'</textarea>';
  const run=mode=>collectEndpoint(source,{mode,targetMode,repair:false,client:client(()=>response)});
  const full=await run('full'),list=await run('list');
  assert.equal(full.jobs.length,1);assert.equal(full.jobs[0].body_complete,false);
  assert.equal(full.coverage.list_complete,true);assert.equal(full.coverage.status,'partial');assert.equal(full.coverage.collection_complete,false);
  assert.match(full.coverage.reason,/job_details_not_collected/);assert.equal(list.coverage.status,'complete');
});

test('published registry has one owner per reviewed employer identity and preserves consolidated interfaces',()=>{
  const registry=JSON.parse(fs.readFileSync(new URL('../../../../../shared/job-search-core/assets/sources.json',import.meta.url),'utf8'));
  const decisions=JSON.parse(fs.readFileSync(new URL('../../../../../shared/job-search-core/assets/company-identity-consolidations.json',import.meta.url),'utf8'));
  const ids=new Set(registry.companies.map(c=>c.company_id)),owners=new Map();
  assert.equal(ids.size,registry.companies.length);
  for(const c of registry.companies)for(const source of c.recruitment_sources||[c]){
    const key=reviewedEmployerKey(source);if(!key)continue;
    if(owners.has(key))assert.equal(owners.get(key),c.company_id,'reviewed identity split between company IDs');
    owners.set(key,c.company_id);assert.equal(source.company_id,c.company_id);
  }
  for(const group of decisions.groups){
    assert.ok(group.retired_company_ids.every(id=>!ids.has(id)));
    const company=registry.companies.find(c=>c.company_id===group.company_id);
    const sources=new Set(company.recruitment_sources.map(s=>s.source_id));
    assert.ok(group.source_ids.every(id=>sources.has(id)));
    const interfaces=new Map();
    for(const source of company.recruitment_sources){
      const key=sourceKey(source);
      if(interfaces.has(key)){
        // An official migration can converge on an already retained interface.
        // Preserve the historic source IDs, but require a recorded distinct old route.
        assert.ok([source,interfaces.get(key)].some(s=>s.repair_history?.some(h=>h.previous_fingerprint&&h.previous_fingerprint!==h.current_fingerprint&&h.kind==='official_application_site_migration')),'duplicate interface without verified migration history');
      }
      interfaces.set(key,source);
    }
  }
});
