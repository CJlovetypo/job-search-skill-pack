import test from 'node:test';
import assert from 'node:assert/strict';
import {expandRecruitmentRoutes,validateRecruitmentRoutes,routeConfigFingerprint} from '../lib/recruitment-routes.mjs';
import {directionSources} from '../lib/source-directions.mjs';
import {collectCompanySources,collectEndpoint,mergeSourceResults} from '../lib/source-collector.mjs';
import {collectTargeted} from '../lib/collect-targeted.mjs';
import {sourceConfigFingerprint} from '../lib/source-fingerprint.mjs';
import {directionSourceKey} from '../lib/direction-validation.mjs';
import {reconcileTargetJob} from '../lib/target-api-proof.mjs';
import {reviewRecruitment} from '../lib/recruitment-policy.mjs';
const modes=['campus','social','internship'];
const source=()=>({company_id:'c',display_name:'C',source_id:'s',provider:'beisen',primary_entry_url:'https://fixture.invalid/jobs',validated_api_request_examples:[{purpose:'job_list',url:'https://fixture.invalid/api/Jobad/GetJobAdPageList',method:'POST',body:{Category:['2'],PortalId:'tenant'}}],collection_routes:[{route_id:'students',adapter_route:'configured',overrides:{}},{route_id:'experienced',adapter_route:'configured',overrides:{validated_api_request_examples:[{purpose:'job_list',url:'https://fixture.invalid/api/Jobad/GetJobAdPageList',method:'POST',body:{Category:['1'],PortalId:'tenant'}}]}}],recruitment_modes:{campus:{status:'declared',route_ids:['students']},internship:{status:'legacy_unverified',route_ids:['students']},social:{status:'declared',route_ids:['experienced']}}});
const result=(jobs=[])=>({jobs,requests:[],coverage:{status:'complete',pages:1,collection_complete:true}});
test('explicit direction relations select requests once, preserve business filters and share a student stream',async()=>{
 const s=source(),intern=(await directionSources(s,{targetMode:'internship'})).sources;
 assert.equal(intern.length,1);assert.deepEqual(intern[0].validated_api_request_examples[0].body,{Category:['2'],PortalId:'tenant'});
 assert.equal(expandRecruitmentRoutes(s,'social')[0].validated_api_request_examples[0].body.Category[0],'1');
 assert.equal(expandRecruitmentRoutes(s,'campus')[0].route_config_fingerprint,intern[0].route_config_fingerprint);
 assert.equal(s.route_id,undefined);
});
test('full and targeted retrieval execute exactly the same selected routes',async()=>{
 const s=source(),seen=[];const collector=async(s)=>{seen.push(s.route_id);return result();};
 await collectCompanySources(s,{targetMode:'social'},collector);
 await collectTargeted(s,{mode:'targeted',target:'engineer',company_ids:['c'],keywords:['engineer']},{targetMode:'social'}, {},collector);
 assert.deepEqual(seen,['experienced','experienced']);
});
test('unsupported direction makes no requests and remains unavailable, never complete-empty',async()=>{
 const s=source();s.collection_routes.pop();s.recruitment_modes.social={status:'not_supported',route_ids:[],evidence_url:'https://fixture.invalid/scope',limitation:'This portal only publishes student jobs'};
 const r=await collectCompanySources(s,{targetMode:'social'},()=>{throw Error('must not call');});
 assert.equal(r.coverage.status,'unavailable');assert.equal(r.coverage.collection_complete,false);
});
test('route schema rejects missing modes, dangling routes, duplicate IDs and unregistered overrides',()=>{
 for(const change of [s=>delete s.recruitment_modes.social,s=>s.recruitment_modes.social.route_ids=['missing'],s=>s.collection_routes.push(s.collection_routes[0]),s=>s.collection_routes[0].overrides.company_id='other',s=>s.collection_routes[0].adapter_route='unknown',s=>s.collection_routes[0].overrides.primary_entry_url='https://another-employer.invalid/jobs',s=>{s.api_config={tenant:'original'};s.collection_routes[0].overrides.api_config={tenant:'other'}},s=>{s.validated_api_request_examples[0].body.orgId='original';s.collection_routes[1].overrides.validated_api_request_examples[0].body.orgId='other'}]){const s=source();change(s);assert.throws(()=>validateRecruitmentRoutes(s));}
});
test('route fingerprints ignore labels and proof dates but invalidate business filters and employer scope',()=>{
 const s=source(),a=expandRecruitmentRoutes(s,'social')[0],b=structuredClone(a);b.display_name='new';b.source_verification={checked_at:'tomorrow'};b.validated_api_request_examples[0].response_file='private/archive.json';b.validated_api_request_examples[0].checked_at='tomorrow';
 assert.equal(routeConfigFingerprint(a),routeConfigFingerprint(b));assert.equal(directionSourceKey(s,a,0),directionSourceKey({...s,display_name:'new'},b,7));
 b.validated_api_request_examples[0].body.PortalId='other';assert.notEqual(routeConfigFingerprint(a),routeConfigFingerprint(b));
 const c=structuredClone(s);c.collection_routes[1].overrides.api_config={employer_filter:'child'};assert.notEqual(sourceConfigFingerprint(s,'social'),sourceConfigFingerprint(c,'social'));assert.equal(sourceConfigFingerprint(s,'campus'),sourceConfigFingerprint(c,'campus'));
});
test('shared jobs retain stable IDs and every route provenance; incomplete routes block complete coverage',()=>{
 const s=source(),a=expandRecruitmentRoutes(s,'campus')[0],b={...a,route_id:'extra'},job={job_id:'1',formal_status:'internship'};
 const r=mergeSourceResults(s,[{source:a,result:result([job])},{source:b,result:{...result([job]),coverage:{status:'failed',pages:0}}}],{targetMode:'internship',mode:'list'});
 assert.equal(r.jobs.length,1);assert.equal(r.jobs[0].job_id,'1');assert.deepEqual(r.jobs[0].source_route_ids,['s/students','s/extra']);assert.equal(r.coverage.collection_complete,false);
});
test('all target modes classify the same full JD and reject bare inherited formal status',()=>{
 const base={company_id:'c',job_id:'1',title:'软件工程师',formal_status:'unknown',open_status:'open',body_complete:true,description:'负责软件功能设计开发、项目落地和质量维护。',requirements:'计算机专业，掌握编程基础和团队协作能力。',official_url:'https://fixture.invalid/1'};
 for(const [e,title,expected] of [[{provider:'beisen',CategoryId:2},'软件工程师','formal'],[{provider:'hotjob',recruitType:1},'软件实习生','internship'],[{provider:'moka',hireMode:1},'软件工程师','social'],[{provider:'moka',campus_context:true,commitment:'全职'},'软件工程师','unknown']]){
  for(const mode of modes){const j=reviewRecruitment({...base,title,recruitment_evidence:e},mode);assert.equal(reconcileTargetJob(j,source(),mode).formal_status,expected);}
 }
 for(const mode of modes)assert.equal(reconcileTargetJob({...base,formal_status:'formal'},source(),mode).formal_status,'unknown');
});
test('explicit configured requests do not widen internship filters at runtime',async t=>{
 const seen=[];t.mock.method(globalThis,'fetch',async(url,options)=>{seen.push(options?.body);return new Response(JSON.stringify({Code:200,Data:[],Count:0}),{status:200});});
 const s=source();s.public_bootstrap_requests=[];
 await collectEndpoint(s,{targetMode:'internship',mode:'list',maxPages:1,requestBudget:{remaining:3}});
 assert.equal(seen.filter(Boolean).length,1);assert.deepEqual(JSON.parse(seen.find(Boolean)).Category,['2']);
});

import {refreshedCityTag} from '../lib/city-index.mjs';
test('complete query with an unverified direction keeps prior cities as historical observations',()=>{
 const r=refreshedCityTag(source(),{jobs:[],coverage:{status:'complete',direction_sources:[{source_id:'s',status:'legacy_unverified'}]}},{cities:['上海'],updated_at:'2026-01-01'},{mode:'social',fingerprint:'new'});
 assert.equal(r.city_coverage_complete,false);assert.deepEqual(r.cities,['上海']);assert.equal(r.city_freshness,'partial_with_history');
});
