import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectRecovered,coapiUrl} from '../lib/providers-recovered.mjs';
import {collectOracleNowcoder} from '../lib/providers-oracle-nowcoder.mjs';
import {collectXYZ,publicXYZSign} from '../lib/providers-51job-xyz.mjs';
import {coapiUrl as originalCoapiUrl} from '../lib/providers-recovered.mjs';
import {publicXYZSign as originalXYZSign} from '../lib/providers-51job-xyz.mjs';

const body='岗位职责：参与产品研发设计与需求沟通，完成软件系统的开发维护和测试工作。\n任职要求：本科及以上学历，熟悉计算机基础知识，具备良好的沟通协作能力和问题分析能力。';
const source=(provider,api_config)=>({provider,api_config,company_id:'fixture-company',display_name:'测试公司'});
const co=source('51job_coapi',{ctmid:'123'}),oracle=source('oracle_recruiting',{origin:'https://fixture.example',site:'CX_1',location_id:'CN'});
const coRow=(id,city,extra={})=>({jobid:id,jobname:'校招开发工程师 '+id,ctmid:'123',jobareaname:city,...extra});
const oraRow=(id,city,extra={})=>({Id:id,Title:'校招开发工程师 '+id,PrimaryLocation:city,PrimaryLocationCountry:'CN',...extra});
function mock(handler) {
  return {records:[],calls:[],async request(q,meta){
    this.calls.push({q,...meta});
    const data=await handler(q,meta,this.calls.length),record={http_status:200,response_file:'fixture-response-'+this.calls.length+'.json'};
    this.records.push(record);return {data,text:JSON.stringify(data),record};
  }};
}
function coClient(rows,detail=id=>({...rows.find(x=>String(x.jobid)===id),jobinfo:body})) {
  return mock(q=>{const u=new URL(q.url),p=JSON.parse(u.searchParams.get('params'));
    return /job_list/.test(u.pathname)?{status:'1',resultbody:{joblist:rows,totalnum:rows.length}}:{status:'1',resultbody:detail(String(p.jobid))};});
}
function oracleClient(rows,detail=id=>({...rows.find(x=>String(x.Id)===id),ExternalDescriptionStr:body})) {
  return mock(q=>{const u=new URL(q.url);
    return /recruitingCEJobRequisitionDetails/.test(u.pathname)?{items:[detail(u.searchParams.get('finder').match(/Id="([^"]+)"/)[1])]}:{items:[{requisitionList:rows,TotalJobsCount:rows.length}]};});
}
const details=client=>client.calls.filter(x=>x.purpose==='job_detail');
const get=(r,id)=>r.jobs.find(j=>j.job_id===id);

test('CoAPI list/default: known metadata needs no per-job HTTP; missing bodies remain visible',async()=>{
  const client=coClient(['上海','北京','深圳'].map((city,i)=>coRow(String(i),city,{jobname:'软件开发实习'})));
  const r=await collectRecovered(co,{client});
  assert.equal(details(client).length,0);assert.equal(r.jobs.length,3);
  assert.equal(r.coverage.status,'complete');assert.equal(r.coverage.list_complete,true);
  assert.equal(r.coverage.incomplete_bodies,3);assert.equal(r.coverage.required_incomplete_bodies,0);
  assert.equal(get(r,'0').raw_file,get(r,'0').list_raw_file);
});
test('CoAPI full: CLI cities alias skips Beijing only; unknown location fetched; list fields preserved',async()=>{
  const client=coClient([coRow('a','上海'),coRow('b','北京'),coRow('c','')],id=>({jobid:id,ctmid:'123',jobinfo:body,jobareaname:''}));
  const r=await collectRecovered(co,{client,mode:'full',cities:['上海']});
  assert.equal(details(client).length,2);assert.equal(r.jobs.length,3);assert.equal(r.coverage.status,'complete');
  assert.equal(get(r,'b').detail_skipped_reason,'explicit_non_target_city');assert.equal(get(r,'b').body_complete,false);
  assert.deepEqual(get(r,'a').cities,['上海']);assert.equal(get(r,'a').title,'校招开发工程师 a');
  assert.equal(get(r,'c').body_complete,true);assert.equal(r.coverage.incomplete_bodies,1);assert.equal(r.coverage.required_incomplete_bodies,0);
});
test('CoAPI failed detail ID retains the list row and evidence, full coverage remains partial',async()=>{
  const client=coClient([coRow('a','上海')],()=>({jobid:'wrong-id',ctmid:'123',jobinfo:body}));
  const r=await collectRecovered(co,{client,mode:'full',cityFilters:['上海']});
  assert.equal(r.jobs.length,1);assert.equal(get(r,'a').body_complete,false);assert.match(get(r,'a').raw_metadata.detail_fetch_error,/mismatch/);
  assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.list_complete,true);assert.equal(r.coverage.details_failed,1);
});
test('CoAPI validation limit is explicit and never counts a skipped request as a failed request',async()=>{
  const client=coClient([coRow('a','上海'),coRow('b','北京')]);
  const r=await collectRecovered(co,{client,mode:'full',validationMaxDetails:0});
  assert.equal(details(client).length,0);assert.equal(r.jobs.length,2);assert.equal(r.coverage.status,'partial');
  assert.equal(r.coverage.details_skipped_limit,2);assert.equal(r.coverage.details_failed,0);
});
test('CoAPI later list failure retains previously acquired rows and still fetches their requested bodies',async()=>{
  const client=mock(q=>{const u=new URL(q.url),p=JSON.parse(u.searchParams.get('params'));
    if(/job_detail/.test(u.pathname))return {status:'1',resultbody:{...coRow('a','上海'),jobinfo:body}};
    if(p.pagenum===2)throw Error('fixture page 2 unavailable');
    return {status:'1',resultbody:{joblist:[coRow('a','上海')],totalnum:2}};});
  const r=await collectRecovered(co,{client,mode:'full',pageSize:1});
  assert.equal(r.jobs.length,1);assert.equal(get(r,'a').body_complete,true);assert.equal(r.coverage.status,'partial');
  assert.equal(r.coverage.list_complete,false);assert.match(r.coverage.reason,/page 2/);
});
test('Oracle list mode with known metadata requests no details and keeps all explicit-CN list locations',async()=>{
  const client=oracleClient(['上海','北京','深圳'].map((city,i)=>oraRow(String(i),city,{Title:'软件开发实习'})));
  const r=await collectOracleNowcoder(oracle,{client,mode:'list'});
  assert.equal(details(client).length,0);assert.equal(r.jobs.length,3);assert.equal(r.coverage.status,'complete');
  assert.equal(r.coverage.incomplete_bodies,3);assert.equal(get(r,'0').location_unknown,false);
});
test('Oracle full: includes multi-city and unknown rows; explicit non-target rows survive without detail',async()=>{
  const rows=[oraRow('a','北京',{secondaryLocations:[{Name:'上海'}]}),oraRow('b','北京'),oraRow('c','')];
  const client=oracleClient(rows,id=>({Id:id,ExternalDescriptionStr:body,PrimaryLocation:null,secondaryLocations:[]}));
  const r=await collectOracleNowcoder(oracle,{client,mode:'full',cityFilters:['上海']});
  assert.equal(details(client).length,2);assert.equal(r.jobs.length,3);assert.equal(r.coverage.status,'complete');
  assert.deepEqual(get(r,'a').cities,['北京','上海']);assert.equal(get(r,'a').title,'校招开发工程师 a');
  assert.equal(get(r,'b').detail_skipped_reason,'explicit_non_target_city');assert.equal(get(r,'c').body_complete,true);
});
test('Oracle country scope checks still run before city or list optimizations',async()=>{
  const client=oracleClient([oraRow('a','上海',{Title:'软件开发实习'}),oraRow('b','Shanghai',{PrimaryLocationCountry:'US'}),oraRow('c','上海',{PrimaryLocationCountry:undefined})]);
  const r=await collectOracleNowcoder(oracle,{client,mode:'list'});
  assert.equal(r.jobs.length,1);assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.excluded_location_rows.length,2);
  assert.equal(details(client).length,0);
});
test('Oracle later list failure preserves first-page rows and partial status',async()=>{
  const client=mock(q=>{
    if(/offset=1(?:,|$)/.test(q.url))throw Error('fixture page 2 unavailable');
    return {items:[{requisitionList:[oraRow('a','上海',{Title:'软件开发实习'})],TotalJobsCount:2}]};});
  const r=await collectOracleNowcoder(oracle,{client,mode:'list'});
  assert.equal(r.jobs.length,1);assert.equal(r.coverage.list_complete,false);assert.equal(r.coverage.status,'partial');
});
test('Oracle global scan uses the observed 200-row service window',async()=>{
  const seen=[];const client=mock(q=>{
    const offset=Number(q.url.match(/offset=(\d+)/)[1]);seen.push({offset,url:q.url});
    const rows=offset===0?[oraRow('a','上海',{Title:'软件开发实习'})]:[oraRow('b','北京',{Title:'软件开发实习'})];
    return {items:[{requisitionList:rows,TotalJobsCount:2}]};
  });
  const r=await collectOracleNowcoder({...oracle,api_config:{origin:'https://fixture.example',site:'CX_1'}},{client,mode:'list',pageSize:20});
  assert.deepEqual(seen.map(x=>x.offset),[0,200]);assert.ok(seen.every(x=>/limit=200/.test(x.url)));assert.equal(r.coverage.status,'complete');assert.equal(r.coverage.list_complete,true);assert.deepEqual(r.jobs.map(x=>x.job_id),['a','b']);
});
test('Oracle HTTP success with insufficient JD body is partial in full mode',async()=>{
  const client=oracleClient([oraRow('a','上海')],id=>({Id:id,ExternalDescriptionStr:'Short text.'}));
  const r=await collectOracleNowcoder(oracle,{client,mode:'full'});
  assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.list_complete,true);
  assert.equal(r.coverage.required_incomplete_bodies,1);assert.equal(r.coverage.details_failed,0);
});
test('CoAPI list enriches uncertain recruitment type and location, skipping known rows only',async()=>{
  const rows=[coRow('a','上海',{jobname:'软件开发实习'}),coRow('b','上海'),coRow('c','',{jobname:'软件开发实习'})];
  const client=coClient(rows,id=>({...rows.find(x=>x.jobid===id),jobinfo:body,jobareaname:id==='c'?'广州':'上海'}));
  const r=await collectRecovered(co,{client,mode:'list'});
  assert.equal(details(client).length,2);assert.equal(r.jobs.length,3);assert.equal(r.coverage.status,'complete');
  assert.equal(get(r,'b').formal_status,'formal');assert.deepEqual(get(r,'c').cities,['广州']);
  assert.equal(r.coverage.details_skipped_mode,1);assert.equal(r.coverage.metadata_unresolved,0);
});
test('Oracle list enriches uncertain recruitment type and location without full-body requirement',async()=>{
  const rows=[oraRow('a','上海',{Title:'软件开发实习'}),oraRow('b','上海'),oraRow('c','',{Title:'软件开发实习'})];
  const client=oracleClient(rows,id=>({...rows.find(x=>x.Id===id),ExternalDescriptionStr:id==='c'?'Short text':body,PrimaryLocation:id==='c'?'广州':'上海'}));
  const r=await collectOracleNowcoder(oracle,{client,mode:'list'});
  assert.equal(details(client).length,2);assert.equal(r.coverage.status,'complete');
  assert.equal(get(r,'b').formal_status,'formal');assert.deepEqual(get(r,'c').cities,['广州']);
  assert.equal(get(r,'c').body_complete,false);assert.equal(r.coverage.required_incomplete_bodies,0);assert.equal(r.coverage.metadata_unresolved,0);
});
test('List metadata request failure retains unknown status and reports partial, not fabricated tags',async()=>{
  const client=oracleClient([oraRow('a','')],()=>{throw Error('fixture metadata request failed');});
  const r=await collectOracleNowcoder(oracle,{client,mode:'list'});
  assert.equal(r.jobs.length,1);assert.equal(get(r,'a').formal_status,'unknown');assert.equal(get(r,'a').location_unknown,true);
  assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.metadata_unresolved,1);assert.equal(r.coverage.required_incomplete_bodies,0);
});

const listProviders=[
  {name:'Grace',s:source('zhaopin_grace',{org_number:'org-1',job_source:2}),run:collectRecovered,
    row:(id,city,content)=>({job:{jobNumber:id,title:'校招开发工程师',detail:content,cityName:city,url:'https://fixture.example/job/'+id}}),
    payload:rows=>({code:200,data:{jobList:rows,pageInfo:{totalNum:rows.length}}})},
  {name:'Greenhouse',s:source('greenhouse',{board_token:'fixture',mainland_location_pattern:'China|上海|北京'}),run:collectRecovered,
    row:(id,city,content)=>({id,title:'校招开发工程师',content,location:{name:city},absolute_url:'https://fixture.example/job/'+id}),
    payload:rows=>({jobs:rows,meta:{total:rows.length}})},
  {name:'Nowcoder',s:source('nowcoder_public',{company_id:42}),run:collectOracleNowcoder,
    row:(id,city,content)=>({id,jobName:'校招开发工程师',companyId:42,jobCityList:[city],ext:JSON.stringify({infos:content})}),
    payload:rows=>({code:0,data:{datas:rows.map(data=>({data})),totalCount:rows.length}})},
  {name:'XYZ',s:source('51job_xyz',{ehire_ctm_id:'123'}),run:collectXYZ,
    row:(id,city,content)=>({jobId:id,ehireJobId:'e-'+id,ehireCtmId:'123',jobName:'校招开发工程师',jobInfo:content,jobAreas:city,isExpired:false}),
    payload:rows=>({result:'1',data:{records:rows,total:rows.length}})}
];
for(const p of listProviders) {
  const setup=()=>mock(q=>/get_customer_setting/.test(q.url)?{result:'1',data:{ctmId:'public-guid'}}:p.payload([p.row('a','上海',body),p.row('b','北京','')]));
  test(p.name+' embedded JD: no separate detail request, list completeness independent of missing body',async()=>{
    const client=setup(),r=await p.run(p.s,{client,mode:'list'});
    assert.equal(details(client).length,0);assert.equal(r.jobs.length,2);assert.equal(r.coverage.status,'complete');
    assert.equal(r.coverage.incomplete_bodies,1);assert.equal(get(r,'a').body_complete,true);
  });
  test(p.name+' embedded JD: city scope retains out-of-city rows and separates required body gaps',async()=>{
    const client=setup(),r=await p.run(p.s,{client,mode:'full',cities:['上海']});
    assert.equal(r.jobs.length,2);assert.equal(get(r,'b').detail_skipped_reason,'explicit_non_target_city');
    assert.equal(r.coverage.status,'complete');assert.equal(r.coverage.required_incomplete_bodies,0);assert.equal(details(client).length,0);
    const unfiltered=await p.run(p.s,{client:setup(),mode:'full'});assert.equal(unfiltered.coverage.status,'partial');
  });
}
test('Greenhouse retains existing mainland scope guard and excluded evidence',async()=>{
  const p=listProviders[1],rows=[p.row('a','上海',body),p.row('b','New York, US',body)];
  const r=await p.run(p.s,{mode:'full',client:mock(()=>p.payload(rows))});
  assert.equal(r.jobs.length,1);assert.equal(r.coverage.excluded_location_rows.length,1);assert.equal(r.coverage.server_total,2);
  assert.equal(r.coverage.status,'complete');
});
test('Nowcoder employer guard cannot be bypassed by explicit non-target city',async()=>{
  const p=listProviders[2],rows=[{...p.row('a','北京',body),companyId:99}];
  const r=await p.run(p.s,{mode:'full',cities:['上海'],client:mock(()=>p.payload(rows))});
  assert.equal(r.coverage.status,'partial');assert.match(r.coverage.reason,/employer mismatch/);assert.equal(r.jobs.length,0);
  assert.equal(r.coverage.excluded_employer_rows[0].returned_company_id,99);
});
test('XYZ sends the keyword on every signed list page in all recruitment directions',async()=>{
  const p=listProviders.find(p=>p.name==='XYZ'),keyword='研发 工程师';
  for(const targetMode of ['campus','internship','social']) {
    const client=mock(q=>{
      if(/get_customer_setting/.test(q.url))return {result:'1',data:{ctmId:'public-guid'}};
      assert.equal(q.method,'POST');assert.equal(q.body.keyWord,keyword);
      assert.equal(q.body.ctmId,'public-guid');assert.match(q.body.sign,/^[a-f0-9]{32}$/);
      return {result:'1',data:{records:[p.row(String(q.body.pageIndex),'上海',body)],total:2}};
    });
    const r=await p.run(p.s,{client,targetMode,keyword,pageSize:1,maxPages:3});
    const lists=client.calls.filter(x=>x.purpose==='job_list_with_full_JD');
    assert.deepEqual(lists.map(x=>({page:x.q.body.pageIndex,keyword:x.q.body.keyWord})),[{page:1,keyword},{page:2,keyword}]);
    assert.deepEqual(r.jobs.map(j=>j.job_id),['1','2']);assert.equal(r.coverage.status,'complete');
  }
});
test('XYZ existing tenant guard remains active in list mode',async()=>{
  const p=listProviders[3],client=mock(q=>/get_customer_setting/.test(q.url)?{result:'1',data:{ctmId:'public-guid'}}:p.payload([{...p.row('a','上海',body),ehireCtmId:'other-tenant'}]));
  const r=await p.run(p.s,{mode:'list',client});assert.equal(r.jobs.length,0);assert.equal(r.coverage.status,'partial');assert.match(r.coverage.reason,/Tenant mismatch/);
});
test('Duplicate IDs and drifting totals never produce complete list coverage',async()=>{
  for(const [run,s,make,payload] of [
    [collectRecovered,co,coRow,(rows,total)=>({status:'1',resultbody:{joblist:rows,totalnum:total}})],
    [collectOracleNowcoder,oracle,oraRow,(rows,total)=>({items:[{requisitionList:rows,TotalJobsCount:total}]})]
  ]) {
    let page=0;const client=mock(()=>++page===1?payload([make('a','上海')],3):payload([make('a','上海'),make('b','上海')],2));
    const r=await run(s,{client,mode:'list',pageSize:1});assert.equal(r.jobs.length,2);assert.equal(r.coverage.list_complete,false);
    assert.equal(r.coverage.status,'partial');assert.match(r.coverage.reason,/server_total_changed/);assert.match(r.coverage.reason,/duplicate_job_ids/);
  }
});
