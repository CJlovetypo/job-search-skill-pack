import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import {collectSelfHosted,normalizeSelfHosted} from '../lib/providers-selfhosted.mjs';
import {hcmcloudProtocol} from '../lib/provider-hcmcloud.mjs';

const full='负责业务系统设计、功能开发、测试验证和技术文档编写，并与团队协作完成稳定交付。';
const req='本科及以上学历，具备扎实专业基础、良好沟通能力和独立分析解决问题的能力。';
const source=(provider)=>({company_id:'synthetic',display_name:'测试公司',provider,api_config:{campus_stream:true}});

test('self-hosted normalizers preserve structured campus evidence and complete bodies',()=>{
  const ths=normalizeSelfHosted(source('10jqka_campus'),{id:1,name:'算法工程师',intro:full,requirement:req,base:'杭州',apply_recruitment_series_name:'2027届校园招聘'},'raw');
  assert.equal(ths.formal_status,'formal');assert.equal(ths.body_complete,true);assert.match(ths.official_url,/id=1/);
  const cec=normalizeSelfHosted(source('cec_campus'),{id:2,name:'研发工程师',jobDescription:full,jobRequirements:req,cityName:'上海',positionType:0,applyable:true,org:'测试子公司'},'raw');
  assert.equal(cec.formal_status,'formal');assert.equal(cec.open_status,'open');assert.equal(cec.raw_metadata.employer_name,'测试子公司');
  const wenhua=normalizeSelfHosted(source('wenhua_public'),{id:3,position:'开发工程师',status:1,listH:[{name:'工作地点',note:'上海'}],listV:[{name:'招聘对象',note:'2027届应届本科及以上毕业生，具备良好专业基础。'},{name:'岗位介绍',note:full}]},'raw');
  assert.equal(wenhua.formal_status,'formal');assert.equal(wenhua.body_complete,true);
  const ccb=normalizeSelfHosted(source('ccb_public'),{planId:'p',planPost:'j',planPostName:'科技类专项人才',planType:'XY',planStatus:'1',orgId:'o',secondOrgId:'s',orgName:'测试分行',workPlace:'上海市',postDesc:full,PostRequest:req},'raw');
  assert.equal(ccb.formal_status,'formal');assert.equal(ccb.open_status,'open');assert.equal(ccb.body_complete,true);assert.equal(ccb.job_id,'p:j:s');
});

test('CEC collector sends the server page field and reconciles every page',async()=>{
  const requests=[];
  const client={records:requests,async request(query){requests.push({body:query.body,http_status:200,response_file:'raw'});const page=query.body.page;
    const records=page===1?[{id:'a',name:'甲',jobDescription:full,jobRequirements:req,cityName:'上海',positionType:0,applyable:true}]:[{id:'b',name:'乙',jobDescription:full,jobRequirements:req,cityName:'北京',positionType:0,applyable:true}];
    return {data:{code:'000000',data:{records,total:2,current:page,size:1}},record:requests.at(-1)};}};
  const result=await collectSelfHosted(source('cec_campus'),{client,pageSize:1,maxPages:3});
  assert.deepEqual(requests.map(item=>item.body.page),[1,2]);assert.equal(result.jobs.length,2);assert.equal(result.coverage.list_complete,true);
});

test('CEC collector exhausts the group list and applies an exact employer field filter',async()=>{
  const requests=[];
  const client={records:requests,async request(query){requests.push({body:query.body,http_status:200,response_file:'raw'});const page=query.body.page;
    const rows={1:[{id:'a',name:'甲',jobDescription:full,jobRequirements:req,cityName:'上海',positionType:0,applyable:true,positionSecondOrg:'中电信息'}],2:[{id:'b',name:'乙',jobDescription:full,jobRequirements:req,cityName:'北京',positionType:0,applyable:true,positionSecondOrg:'其他公司'}],3:[{id:'c',name:'丙',jobDescription:full,jobRequirements:req,cityName:'深圳',positionType:0,applyable:true,positionSecondOrg:'中电信息'}]}[page]||[];
    return {data:{code:'000000',data:{records:rows,total:3,current:page,size:1}},record:requests.at(-1)};}};
  const filtered={...source('cec_campus'),api_config:{query:{positionType:0},employer_filter:{field:'positionSecondOrg',values:['中电信息']}}};
  const result=await collectSelfHosted(filtered,{client,pageSize:1,maxPages:4});
  assert.deepEqual(requests.map(item=>item.body.page),[1,2,3]);assert.deepEqual(result.jobs.map(job=>job.job_id),['a','c']);assert.equal(result.coverage.server_total,3);assert.equal(result.coverage.list_complete,true);
  assert.deepEqual(result.coverage.page_evidence.map(page=>page.accepted_rows),[1,0,1]);
});

test('CEC collector rejects an invalid employer filter before making requests',async()=>{
  const requests=[];const filtered={...source('cec_campus'),api_config:{employer_filter:{field:'unknown',values:['中电信息']}}};
  await assert.rejects(()=>collectSelfHosted(filtered,{client:{records:requests,request:async()=>{throw new Error('must not request');}}}),/Invalid cec_campus employer_filter/);
  assert.equal(requests.length,0);
});

function encryptResponse(value,key,iv){
  const cipher=createCipheriv('aes-128-cbc',Buffer.from(key),Buffer.from(iv));
  return Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]).toString('base64');
}
const swapEncode=value=>value.replaceAll('a','!').replaceAll('5','a');

test('HCMCloud public scene_ext restores keys and decodes HA, HA5 and HB5 markers',()=>{
  const keys={defaultKey:'1234567890abcdef',ha5Key:'abcdef1234567890',hs4Key:'1111222233334444',iv:'fedcba0987654321'};
  const scene='0123456789'+Buffer.from([keys.defaultKey,keys.ha5Key,keys.hs4Key,keys.iv].join('|').split('').reverse().join('')).toString('base64').replace(/=+$/,'')+'abcdefghij';
  assert.deepEqual(hcmcloudProtocol.sceneKeys(`window.scene_ext="${scene}"`),keys);
  const payload={result:{list:[{id:1}]}};
  const haCipher=encryptResponse(payload,keys.defaultKey,keys.iv);
  assert.deepEqual(hcmcloudProtocol.decodePayload({hcm_transfer_strategy:'ha',hcm_param:Buffer.from(haCipher).toString('base64')},'ha',keys),payload);
  const ha5Cipher=encryptResponse(payload,keys.ha5Key,keys.iv);
  assert.deepEqual(hcmcloudProtocol.decodePayload({hcm_transfer_strategy:'ha5',hcm_param:'cod'+swapEncode(Buffer.from(ha5Cipher).toString('base64'))},'ha5',keys),payload);
  const hb5='cod'+swapEncode(Buffer.from(JSON.stringify(payload)).toString('base64'));
  assert.deepEqual(hcmcloudProtocol.decodePayload({hcm_transfer_strategy:'hb5',hcm_param:hb5},'ha5',keys),payload);
});
