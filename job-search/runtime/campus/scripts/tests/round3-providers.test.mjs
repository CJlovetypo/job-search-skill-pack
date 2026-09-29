import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectRound3,normalizeRound3} from '../lib/providers-round3.mjs';

const duty='负责业务系统设计、功能开发、测试验证和技术文档编写，并与团队协作完成稳定交付。';
const requirement='本科及以上学历，具备扎实专业基础、良好沟通能力和独立分析解决问题的能力。';
const source=(provider,name='测试公司',api_config={})=>({company_id:'synthetic',display_name:name,provider,api_config});

test('IHNHR accepts explicit zero with null list but refuses nonzero or failed envelopes',async()=>{
  for(const [code,total,expected] of [[200,0,true],[200,5,false],[401,0,false]]){
    const client={records:[],async request(){return {record:{http_status:200,response_file:'raw'},data:{code,data:{list:null,total}}};}};
    const r=await collectRound3(source('ihnhr_public','测试公司',{company_id:'123'}),{client});
    assert.equal(r.coverage.list_complete,expected);assert.equal(r.jobs.length,0);
  }
});

test('round-3 normalizers preserve provider-specific campus, employer and body evidence',()=>{
  const ct=normalizeRound3(source('ct108_campus','畅唐网络',{locations:['杭州']}),{id:1,name:'开发工程师',jobDescription:duty,responsibility:requirement,status:1,_trail:['应届生','开发工程师']},'raw');
  assert.equal(ct.formal_status,'formal');assert.equal(ct.open_status,'open');assert.equal(ct.body_complete,true);assert.deepEqual(ct.cities,['杭州']);

  const citics=normalizeRound3(source('citics_campus','中信证券'),{positionNo:'10',deptNo:'20',positionName:'培训生',deptName:'上海分公司',workplace:'上海市'},'raw',{stream:'branch',detail:{positionDesc:duty,qualification:requirement,workplace:'上海市',type:'校园招聘'}});
  assert.equal(citics.formal_status,'formal');assert.equal(citics.body_complete,true);assert.match(citics.official_url,/positionNo=10/);

  const crec=normalizeRound3(source('crec_public','中铁测试',{pk_company:'1'}),{id:7,workType:'10271001',state:'10021001',professionalName:'技术岗',postDuty:duty,postDemand:requirement,workArea:'武汉',pkCompany:'1',companyName:'中铁测试'},'raw');
  assert.equal(crec.formal_status,'formal');assert.equal(crec.body_complete,true);assert.deepEqual(crec.cities,['武汉']);

  const sydw=normalizeRound3(source('sydw_public','测试事业单位'),{ggId:'g',gwbm:'001',zpgw:'信息技术岗',zpdw:'测试事业单位',zpryfw:'应届毕业生',gwzz:duty,gwyq:`工作地点：上海；${requirement}`,BmjsFlag:true},'raw',{viewId:'g'});
  assert.equal(sydw.formal_status,'formal');assert.equal(sydw.body_complete,true);assert.deepEqual(sydw.cities,['上海']);

  const jiuji=normalizeRound3(source('jiuji_public','九机'),{id:3924,jobName:'管理高潜管培生（云南）',duty, demand:requirement,city:'昆明市',area:'五华区',typeName:'校园招聘',workTypeName:'全职'},'raw');
  assert.equal(jiuji.formal_status,'formal');assert.equal(jiuji.body_complete,true);assert.deepEqual(jiuji.cities,['昆明']);assert.match(jiuji.official_url,/3924/);

  const leihuo=normalizeRound3(source('leihuo_campus','网易游戏雷火'),{ehr_job_id:3738,ehr_project_id:77,job_name:'游戏策划',job_description:duty,job_requirement:requirement,job_target:'2027届应届毕业生',type_name:'全职',work_place_name:'杭州',job_detail_url:'https://campus.163.com/app/detail/index?id=3738&projectId=77'},'raw');
  assert.equal(leihuo.formal_status,'formal');assert.equal(leihuo.body_complete,true);assert.deepEqual(leihuo.cities,['杭州']);

  const cscec=normalizeRound3(source('cscec8b_public','中建八局发展建设有限公司'),{job_id:2773,job_name_show:'发展建设公司2027届校园招聘',job_desc:`工作职责：${duty} 任职资格：${requirement}`,job_address_name:'全国',ws_company_orgnize_id_user_name:'中国建筑第八工程局有限公司发展建设分公司'},'raw',{companyParam:'14',entityId:'12'});
  assert.equal(cscec.formal_status,'formal');assert.equal(cscec.body_complete,true);assert.deepEqual(cscec.location_special,['全国']);assert.match(cscec.official_url,/2773/);

  const ihnhr=normalizeRound3(source('ihnhr_public','海南交规院'),{job_id:'1',job_name:'总工程师',contents:requirement,company_id:'10685392028336822',company_name:'海南省交通规划勘察设计研究院有限公司',recruitment_type_cn:'社会招聘',nature_cn:'社招',is_graduates:false,status:1,district_list:[{area_cn:'海口-龙华区'}]},'raw');
  assert.equal(ihnhr.formal_status,'social');assert.equal(ihnhr.open_status,'open');assert.deepEqual(ihnhr.cities,['海口']);assert.match(ihnhr.official_url,/job\/detail/);
});

test('public-institution collector applies exact employer filtering and reconciles configured campaign',async()=>{
  const records=[];
  const client={records,async request(query){const record={http_status:200,response_file:'raw'};records.push(record);return {record,data:{items:[
    {ggId:'g',gwbm:'001',zpgw:'甲岗位',zpdw:'目标单位',zpryfw:'应届毕业生',gwzz:duty,gwyq:requirement,BmjsFlag:true},
    {ggId:'g',gwbm:'002',zpgw:'乙岗位',zpdw:'同名之外单位',zpryfw:'应届毕业生',gwzz:duty,gwyq:requirement,BmjsFlag:true},
  ],totalCount:2}};}};
  const result=await collectRound3(source('sydw_public','目标单位',{view_ids:['g'],employer_names:['目标单位']}),{client});
  assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].raw_metadata.employer_name,'目标单位');assert.equal(result.coverage.list_complete,true);
});
