import './context.mjs';
import nodeTest from 'node:test';import assert from 'node:assert/strict';import {collectSf,normalizeSfJob} from '../lib/providers-sf.mjs';
const source={company_id:'fixture-sf',display_name:'SF fixture',primary_entry_url:'https://campus.sf-express.com/',validated_api_request_examples:[{url:'https://campus.sf-express.com/api/web/position/query?intern=2&pageNum=1&pageSize=2',purpose:'job_list'}]};
const row=(id,extra={})=>({id,positionName:'研发工程师',postDuty:'研发系统并维护服务。',jobRequirement:'2027届毕业生，可提前到岗实习。',demandCity:'武汉市,深圳市',seasonType:'2',...extra});
function fake(pages){return{records:[],async request(q){const n=Number(new URL(q.url).searchParams.get('pageNum'));const data=pages[n-1];if(data instanceof Error)throw data;const record={http_status:200,response_file:'fixture-page-'+n+'.json',url:q.url};this.records.push(record);return{data,record};}};}
const page=(n,total,rows,last=false)=>({pageNum:n,total,list:rows,isLastPage:last,hasNextPage:!last});
async function test(name,pages,verify){await nodeTest('SF '+name,async()=>{const r=await collectSf(source,{client:fake(pages),pageSize:2,maxPages:4});verify(r);});}
await test('normal pagination', [page(1,3,[row(1),row(2)]),page(2,3,[row(3)],true)],r=>{assert.equal(r.coverage.status,'complete');assert.equal(r.jobs.length,3);});
await test('total drift keeps rows and partial',[page(1,3,[row(1),row(2)]),page(2,4,[row(3),row(4)],true)],r=>{assert.equal(r.coverage.status,'partial');assert.equal(r.jobs.length,4);assert.match(r.coverage.errors.join(),/server_total_changed/);});
await test('repeated page stops partial',[page(1,4,[row(1),row(2)]),page(2,4,[row(1),row(2)])],r=>{assert.equal(r.coverage.status,'partial');assert.equal(r.jobs.length,2);});
await test('page failure retains previous rows',[page(1,4,[row(1),row(2)]),new Error('fixture timeout')],r=>{assert.equal(r.coverage.status,'partial');assert.equal(r.jobs.length,2);});
await test('missing body is partial',[page(1,1,[row(1,{jobRequirement:''})],true)],r=>{assert.equal(r.coverage.status,'partial');assert.equal(r.jobs[0].body_complete,false);});
await test('successful empty API',[page(1,0,[],true)],r=>{assert.equal(r.coverage.status,'complete');assert.equal(r.jobs.length,0);});
await test('wrong returned page number',[page(9,1,[row(1)],true)],r=>{assert.equal(r.coverage.status,'partial');});
await nodeTest('SF explicit recruitment, city and official detail evidence',()=>{
assert.equal(normalizeSfJob(row(1),source,'fixture').formal_status,'formal'); // advance internship is not an internship role
assert.equal(normalizeSfJob(row(1,{seasonType:'3'}),source,'fixture').formal_status,'internship');
assert.equal(normalizeSfJob(row(1,{positionName:'暑期实习生'}),source,'fixture').formal_status,'internship');
assert.equal(normalizeSfJob(row(1,{positionName:'研发工程师（社招）'}),source,'fixture').formal_status,'social');
assert.equal(normalizeSfJob(row(1,{seasonType:'9'}),source,'fixture').formal_status,'unknown');
assert.equal(normalizeSfJob(row(1),source,'fixture').open_status,'unknown');
assert.equal(normalizeSfJob(row(1),source,'fixture').official_url,'https://campus.sf-express.com/#/postDetail/1');
assert.deepEqual(normalizeSfJob(row(1),source,'fixture').cities,['武汉','深圳']);
});
