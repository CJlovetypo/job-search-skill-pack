import './context.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {directionEndpointProof as check} from '../lib/direction-endpoint-proof.mjs';
test('明确招聘方向的成功空接口可确认，不要求当前JD',()=>{
 const r={http_status:200,url:'https://example.test/GetJobAdPageList',method:'POST',body:{Category:['3']},response_file:'offline-fixture.json'};
 assert.equal(check({provider:'beisen'},'internship',r,{Code:200,Data:[],Count:0}).accepted,true);
 assert.equal(check({provider:'beisen'},'social',r,{Code:200,Data:[]}).accepted,false);
 assert.equal(check({provider:'hotjob'},'internship',{...r,url:'https://example.test/listPosition/SU1',body:'recruitType=12'},{state:200,data:{pageForm:{pageData:[]}}}).accepted,true);
 assert.equal(check({provider:'moka'},'social',{...r,url:'https://example.test/website/jobs/v2',body:{orgId:'org',siteId:'1',site:'social-recruitment'}},{data:{jobs:[]}}).accepted,true);
});
test('HTTP200、错误响应、混合类型查询、纯校园入口均不伪造明确方向证明',()=>{
 const r={http_status:200,url:'https://example.test/GetJobAdPageList',body:{Category:['1','2','3']}};
 assert.equal(check({provider:'beisen'},'internship',r,{Code:200,Data:[]}).accepted,false);
 assert.equal(check({provider:'beisen'},'internship',{...r,body:{Category:['3']}},{Code:500,Message:'bad'}).accepted,false);
 assert.equal(check({provider:'moka'},'internship',{...r,url:'https://example.test/website/jobs/v2',body:{site:'campus-recruitment'}},{data:{jobs:[]}}).accepted,false);
 assert.equal(check({provider:'feishu'},'internship',{...r,url:'https://example.test/search/job/posts',body:{recruitment_id_list:['202']}},{code:0,data:{job_post_list:[]}}).accepted,true);
});
