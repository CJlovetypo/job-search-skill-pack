import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectIqvia,normalizeIqviaDetail} from '../../../../../shared/job-search-core/scripts/lib/provider-iqvia.mjs';
const source={provider:'iqvia_public',company_id:'kuntuo',display_name:'昆拓',primary_entry_url:'https://jobs.iqvia.com/en/jobs?businesses=KUNTUO&page=1',api_config:{business:'KUNTUO',country:'China'}};
const row={instance_id:'R123-0',job_req_id:'R123',job_title:'Medical Advisor',hiring_organization:{name:'KUNTUO'},job_location:{address:{city:'Shanghai',country:'China'}},employment_type:'Full time'};
const flight=obj=>'<script>self.__next_f.push('+JSON.stringify([1,'1:'+JSON.stringify(obj)+'\n'])+')</script>';
const detail=(change={})=>flight({job:{...row,application_url:'https://iqvia.wd1.myworkdayjobs.com/IQVIA/job/Shanghai/R123',...change}})+'<script type="application/ld+json">'+JSON.stringify({'@type':'JobPosting',identifier:{value:'R123'},url:'https://jobs.iqvia.com/en/jobs/R123-0',title:row.job_title,jobLocation:{address:{addressCountry:'China'}},directApply:true,description:'<p>Coordinate clinical trial studies and supervise medical quality and study teams.</p><p>Qualifications</p><p>Medical degree and at least three years of clinical research experience.</p>'})+'</script>';
test('IQVIA preserves exact business and China scope instead of admitting group inventory',async()=>{
 const responses=[flight({jobs:[row,{...row,instance_id:'R124-0',job_req_id:'R124',hiring_organization:{name:'AVACARE'}},{...row,instance_id:'R125-0',job_req_id:'R125',job_location:{address:{city:'London',country:'United Kingdom'}}}]}),detail()];let i=0;
 const client={records:[],request:async(req)=>{const record={http_status:200,response_file:'fixture',url:req.url};client.records.push(record);return{text:responses[i++],record};}};
 const result=await collectIqvia(source,{client,mode:'full'});assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].body_complete,true);assert.equal(result.coverage.server_total,1);assert.equal(result.coverage.upstream_inventory_count,3);assert.match(client.records[0].url,/businesses=KUNTUO/);
});
test('IQVIA rejects mismatched detail employer and instance rather than relabeling it',()=>{
 assert.throws(()=>normalizeIqviaDetail(detail({hiring_organization:{name:'IQVIA'}}),row,source,{}),/scope mismatch/);
 assert.throws(()=>normalizeIqviaDetail(detail({instance_id:'R999-0'}),row,source,{}),/identity mismatch/);
});
test('IQVIA requires explicit confirmed scope and treats missing inventory as failed',async()=>{
 await assert.rejects(()=>collectIqvia({...source,api_config:{business:'IQVIA',country:'China'}}),/verified official/);
 const r=await collectIqvia(source,{client:{records:[],request:async()=>({text:'<html>Maintenance</html>',record:{http_status:200}})}});assert.equal(r.coverage.status,'failed');assert.equal(r.coverage.server_total,null);
});
test('IQVIA keeps duties-only bodies incomplete and survives multiline Flight text records',()=>{
 const html=detail().replace('Qualifications</p><p>Medical degree and at least three years of clinical research experience.','Additional trial monitoring responsibilities are assigned to this position.');
 assert.equal(normalizeIqviaDetail(html,row,source,{}).body_complete,false);
 const prefix='<script>self.__next_f.push('+JSON.stringify([1,'22:T18,arbitrary\ntext\n'])+')</script>';
 assert.equal(normalizeIqviaDetail(prefix+detail(),row,source,{}).body_complete,true);
});
