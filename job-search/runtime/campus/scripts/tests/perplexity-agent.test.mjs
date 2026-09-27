import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {answerWithWeb,buildAgentRequest,normalizeAgentResponse,retryDelay} from '../../../../../shared/job-search-core/scripts/lib/perplexity-agent.mjs';

const wire={id:'resp_test',object:'response',created_at:1,model:'test/model',status:'completed',output:[
  {type:'search_results',queries:['company official'],results:[{url:'https://example.com',title:'Official',snippet:'A source'}]},
  {type:'message',role:'assistant',content:[{type:'output_text',text:'An answer',annotations:[{type:'url_citation',url:'https://example.com',title:'Official'}]}]}
]};
const response=(body=wire,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
test('Agent request uses explicit grounding tools, continuation and documented structured output',()=>{
  const schema={name:'CompanyFacts',schema:{type:'object',properties:{name:{type:'string'}},required:['name']}};
  const request=buildAgentRequest({input:'company',schema,previousResponseId:'resp_previous'});
  assert.equal(request.preset,'low');assert.equal(request.previous_response_id,'resp_previous');
  assert.deepEqual(request.response_format,{type:'json_schema',json_schema:schema});
  assert.deepEqual(request.tools,[{type:'web_search'},{type:'fetch_url'}]);
  assert.throws(()=>buildAgentRequest({input:'x',model:'a',preset:'low'}));
  assert.throws(()=>buildAgentRequest({input:' '}));
});
test('official SDK request is authenticated at Perplexity and returns convenience text plus provenance',async()=>{
  const old=process.env.PERPLEXITY_API_KEY;process.env.PERPLEXITY_API_KEY='local-test-credential';
  try {
    const result=await answerWithWeb({input:'company'},{fetch:async(url,init)=>{
      assert.match(String(url),/^https:\/\/api\.perplexity\.ai\/v1\/(agent|responses)$/);
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer local-test-credential');
      assert.equal(JSON.parse(init.body).preset,'low');return response();
    }});
    assert.equal(result.output_text,'An answer');assert.equal(result.http_status,200);
    assert.equal(result.citations.length,1);assert.equal(result.grounding_observed,true);
    assert.equal(result.review_state,'answer_requires_independent_review');
  }finally {if(old===undefined)delete process.env.PERPLEXITY_API_KEY;else process.env.PERPLEXITY_API_KEY=old;}
});
test('429 honors Retry-After; long waits stop without early retry; 401 never leaks body or retries',async()=>{
  const old=process.env.PERPLEXITY_API_KEY;process.env.PERPLEXITY_API_KEY='secret-test-value';
  try {
    let calls=0;const waits=[];
    await answerWithWeb({input:'company'},{fetch:async()=>++calls===1?response({error:'limited'},429,{'retry-after':'2'}):response(),wait:async ms=>waits.push(ms)});
    assert.equal(calls,2);assert.deepEqual(waits,[2000]);
    calls=0;
    await assert.rejects(answerWithWeb({input:'company'},{fetch:async()=>{calls++;return response({error:'secret-test-value'},401);}}),error=>error.status===401&&!error.message.includes('secret-test-value'));
    assert.equal(calls,1);
    await assert.rejects(answerWithWeb({input:'company'},{fetch:async()=>response({},429,{'retry-after':'120'}),wait:async()=>assert.fail('must not retry early')}),error=>error.retry_after_ms===120000);
    assert.equal(retryDelay(new Headers({'retry-after':'Wed, 23 Sep 2026 00:01:00 GMT'}),0,Date.parse('2026-09-23T00:00:00Z')),60000);
  }finally {if(old===undefined)delete process.env.PERPLEXITY_API_KEY;else process.env.PERPLEXITY_API_KEY=old;}
});
test('missing key, empty/incomplete answers and invalid JSON fail without false success',async()=>{
  const old=process.env.PERPLEXITY_API_KEY;delete process.env.PERPLEXITY_API_KEY;
  try{await assert.rejects(answerWithWeb({input:'x'}),/PERPLEXITY_API_KEY/);}finally{if(old!==undefined)process.env.PERPLEXITY_API_KEY=old;}
  assert.throws(()=>normalizeAgentResponse({...wire,status:'incomplete',output_text:'partial'},200),/未完成/);
  assert.throws(()=>normalizeAgentResponse({...wire,output_text:''},200),/空回答/);
  assert.throws(()=>normalizeAgentResponse({...wire,output_text:'bad'},200,{structured:true}),/JSON/);
  assert.deepEqual(normalizeAgentResponse({...wire,output_text:'{"name":"x"}'},200,{structured:true}).structured_output,{name:'x'});
  assert.equal(normalizeAgentResponse({...wire,output:[],output_text:'ungrounded'},200).grounding_observed,false);
});
