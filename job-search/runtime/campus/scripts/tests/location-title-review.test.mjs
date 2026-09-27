import './context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {extractTitleLocations,normalizeJobLocations,normalizeLocations,jobCityStatus} from '../lib/locations.mjs';

const titleCities=title=>[...new Set(extractTitleLocations(title).flatMap(e=>e.cities))];

test('标题中的城市前缀、后缀、括号、届次和岗位编号保留可审计证据',()=>{
  for(const [title,expected] of [
    ['售前咨询工程师--2027届校园招聘-南昌',['南昌']],
    ['武汉-学习顾问（考研/专升本项目/四六级项目）-校招(J61805)',['武汉']],
    ['太原博文素养教师(J65302)',['太原']],
    ['【2027届物流】广州海淘校招生',['广州']],
    ['香港校園品牌大使',['香港']],
    ['【武汉】项目经理',['武汉']],
    ['【2027校招】项目经理（北京市）',['北京']],
    ['软件开发工程师, 上海, (New graduate or Entry-level Engineer, 0-2 Years)',['上海']],
    ['数据源产品运营（校招/北京 ）',['北京']],
    ['客服管理（2027届秋招） - 南通(MJ037031)',['南通']],
    ['北京市场专员',['北京']],
    ['武汉项目经理',['武汉']],
    ['工程师_武汉',['武汉']],
  ]){
    assert.deepEqual(titleCities(title),expected,title);
    for(const e of extractTitleLocations(title)){
      assert.equal(e.source,'title');assert.equal(e.title,title);
      assert.equal(title.slice(e.start,e.end),e.text);assert.ok(e.rule);
      assert.deepEqual(JSON.parse(JSON.stringify(e)),e);
    }
  }
});

test('多个标题城市与结构化城市合并，冲突信息不丢失',()=>{
  const j={title:'工程师（北京/广州）-2027校招',locations_raw:['上海市'],cities:['上海']};
  const copy=structuredClone(j),r=normalizeJobLocations(j);
  assert.deepEqual(r.cities,['上海','北京','广州']);assert.deepEqual(r.raw,['上海市']);
  assert.deepEqual(r.title_evidence.map(e=>e.added_cities),[['北京'],['广州']]);
  assert.ok(r.title_evidence.every(e=>e.differs_from_fields));
  assert.ok(r.title_evidence.every(e=>e.field_cities.join()==='上海'));
  assert.equal(jobCityStatus({cities:r.cities,location_unknown:r.unknown},['北京']),'included');
  assert.deepEqual(j,copy);
  assert.deepEqual(titleCities('2026校招-客户运营（广告业务）-base广州/成都'),['广州','成都']);
  assert.deepEqual(titleCities('校园大使(杭州/武汉/长沙/湘潭）'),['杭州','武汉','长沙','湘潭']);
  assert.deepEqual(titleCities('工程师（北京、上海；武汉|深圳）'),['北京','上海','武汉','深圳']);
});

test('明确标题工作地点与英文城市可补空字段',()=>{
  for(const [title,expected] of [
    ['项目经理（工作地点：武汉）',['武汉']],
    ['项目经理（办公地点：广州）',['广州']],
    ['Engineer (based in Shanghai)',['上海']],
    ['Engineer - Hong Kong / Singapore',['香港','新加坡']],
    ['Engineer (Kuala Lumpur)',['吉隆坡']],
    ['Applied Scientist (2026-27 Campus, International Technology Team), Shanghai',['上海']],
    ['Account Rep, Shenzhen Sales Team',['深圳']],
    ["Engineer - Xi'an",['西安']],
  ]){
    const r=normalizeJobLocations({title,locations_raw:[]});
    assert.deepEqual(r.cities,expected,title);assert.equal(r.unknown,false,title);
  }
});

test('普通公司名、大学名、招聘活动和非工作地点不得恢复城市',()=>{
  for(const title of [
    '北京字节跳动科技有限公司2027届招聘','上海科技有限公司-项目经理',
    '某某（北京）有限公司-工程师','中山大学校园大使','武汉理工大学招聘专员',
    '校园大使（南京邮电大学站）','北京大学-上海交通大学联合培养项目',
    '全国招聘会-武汉站','2027全国校园双选会（北京/上海）','工程师（面试地点：武汉）',
    '工程师（宣讲：北京，面试：上海）','Shanghai Electric Company Engineer',
    'Beijing University Campus Ambassador','Bank of Beijing Graduate Program',
    'Xiangtan Engineer','北京路门店运营','南海区工程师','朝阳区项目经理',
  ])assert.deepEqual(titleCities(title),[],title);
  assert.deepEqual(titleCities('工程师（面试地点：北京）（工作地点：武汉）'),['武汉']);
  assert.deepEqual(titleCities('北京科技有限公司-项目经理（武汉）'),['武汉']);
});

test('省级字段由同省标题城市补全，原文与补全依据保留',()=>{
  for(const [raw,title,city] of [
    ['山西省','太原--高中数学教师(J61912)','太原'],
    ['广东','广告投放（广州）-2027校招','广州'],
    ['四川','秋招安全工程师—成都','成都'],
    ['湖北省','武汉-学习顾问','武汉'],
  ]){
    const r=normalizeJobLocations({title,locations_raw:[raw]});
    assert.deepEqual(r.cities,[city]);assert.equal(r.unknown,false);
    assert.deepEqual(r.raw,[raw]);assert.deepEqual(r.title_evidence[0].resolves,[raw]);
  }
  const conflict=normalizeJobLocations({title:'工程师（武汉）',locations_raw:['广东省','神秘园区']});
  assert.deepEqual(conflict.cities,['武汉']);assert.equal(conflict.unknown,true);
  assert.deepEqual(conflict.unresolved,['广东省','神秘园区']);
});

test('行政区还原沿用可靠城市名或一致cityId，不增加歧义地名推断',()=>{
  assert.deepEqual(normalizeLocations(['广东省佛山市南海区']).cities,['佛山']);
  assert.deepEqual(normalizeLocations(['江苏·张家港市']).cities,['张家港']);
  assert.deepEqual(normalizeJobLocations({locations_raw:['江苏省·泰州市'],cities:['泰州']}).unresolved,[]);
  assert.deepEqual(titleCities('工程师（广东省佛山市南海区）'),['佛山']);
  assert.deepEqual(titleCities('工程师（淮安）'),['淮安']);
  assert.deepEqual(normalizeJobLocations({title:'工程师（武汉）',cities:['广东省佛山市南海区']}).cities,['佛山','武汉']);
  const record={cityId:440605,cityName:'南海区'};
  const r=normalizeLocations(['广东·南海区'],[record]);
  assert.deepEqual(r.cities,['佛山']);assert.equal(r.code_evidence[0].evidence_id,'mca-2024-440605');
  assert.deepEqual(normalizeLocations(['广东省佛山市南海区及武汉'],[record]).cities,['佛山','武汉']);
  for(const raw of ['朝阳区','西湖区','南海区','湖北·武昌区','广西·良庆区']){
    assert.deepEqual(normalizeLocations([raw]).cities,[],raw);
  }
  assert.deepEqual(normalizeLocations(['广东省·南山区'],[{id:440305,cityName:'南山区'}]).cities,[]);
  assert.deepEqual(normalizeLocations(['广东省·南山区'],[{cityId:440605,cityName:'南山区'}]).cities,[]);
  const address=normalizeJobLocations({locations_raw:['广州市','海珠区琶洲街道新港东路1138号智通广场C塔']});
  assert.deepEqual(address.cities,['广州']);assert.equal(address.unknown,false);
  assert.ok(address.structured_evidence.some(e=>e.rule==='district_detail_of_named_city'&&e.evidence_id==='mca-2024-440105'));
  assert.equal(normalizeJobLocations({locations_raw:['海珠区琶洲街道新港东路1138号']}).unknown,true);
});

test('正文和已保存结构化城市仍保留，重复归一不会把标题混入raw',()=>{
  const j={title:'工程师（北京/广州）',locations_raw:[],description:'工作地点：杭州/太原'};
  const r=normalizeJobLocations(j);
  assert.deepEqual(r.cities,['杭州','太原','北京','广州']);
  assert.deepEqual(r.description_evidence,['杭州/太原']);assert.deepEqual(r.raw,[]);
  const again=normalizeJobLocations({...j,locations_raw:r.raw,cities:r.cities,location_description_evidence:r.description_evidence,
    location_title_evidence:r.title_evidence});
  assert.deepEqual(again.cities,r.cities);assert.deepEqual(again.raw,r.raw);
  assert.deepEqual(again.title_evidence.map(e=>e.text),['北京','广州']);
  assert.deepEqual(again.title_evidence,r.title_evidence);
  assert.deepEqual(normalizeJobLocations({description:'总部在北京。\n面试地点：上海。'}).cities,[]);
  assert.deepEqual(normalizeJobLocations({cities:['上海','武汉']}).cities,['上海','武汉']);
  assert.deepEqual(normalizeJobLocations({title:null}).title_evidence,[]);
});

test('JSON地点只读明确地点字段，保留原始字符串、字段指针和远程模式',()=>{
  const raw='  {"normalizedCityName":"Shanghai","city":"Shanghai","companyName":"Beijing University","type":"ONSITE"}  ';
  const remote=JSON.stringify({normalizedCityName:'Dalian',city:'Dalian - Virtual',type:'VIRTUAL'});
  const r=normalizeJobLocations({title:'Engineer',locations_raw:[raw,remote]});
  assert.deepEqual(r.raw,[raw,remote]);assert.deepEqual(r.cities,['上海','大连']);
  assert.equal(r.unknown,false);assert.deepEqual(r.special,['远程办公']);
  const first=r.structured_evidence.find(e=>e.pointer==='/normalizedCityName');
  assert.equal(first.raw,raw);assert.equal(first.value,'Shanghai');assert.deepEqual(first.cities,['上海']);
  assert.ok(r.structured_evidence.some(e=>e.pointer==='/type'&&e.value==='VIRTUAL'));
  assert.deepEqual(JSON.parse(JSON.stringify(r.structured_evidence)),r.structured_evidence);
  const array=normalizeLocations(['[{"city":"Beijing"},{"city":"Chengdu"},{"city":"Zhongwei"}]']);
  assert.deepEqual(array.cities,['北京','成都','中卫']);assert.equal(array.unknown,false);
  assert.equal(array.structured_evidence[2].pointer,'/2/city');
});

test('JSON城市字段相互冲突时保留全部城市及分歧，未知字段不借用同名公司',()=>{
  const r=normalizeLocations(['{"normalizedCityName":"Shanghai","city":"Beijing"}']);
  assert.deepEqual(r.cities,['上海','北京']);assert.equal(r.unknown,true);
  assert.ok(r.structured_evidence.every(e=>e.field_disagreement));
  for(const raw of [
    '{"company":"Shanghai","person":"Beijing","interviewLocation":"Wuhan"}',
    '{"city":"Shanghai University"}', '{"city":"Beijing","type":"interview"}',
    '{"city":', '{"city":null}', '[]',
  ]){
    const result=normalizeLocations([raw]);assert.deepEqual(result.cities,[],raw);assert.equal(result.unknown,true,raw);
    assert.deepEqual(result.raw,[raw]);
  }
});

test('园区英文城市按单词边界识别，国家省份不构造城市，修复已拆开的Palo Alto',()=>{
  for(const [raw,expected] of [
    [['Singapore-CapitaSky'],['新加坡']],
    [['United','Kingdom-London'],['伦敦']],
    [['US-California-Palo','Alto'],['帕洛阿尔托']],
    [['China, Jiangsu, Suzhou','China, Shanghai, Shanghai'],['苏州','上海']],
    [['China, Jiangsu, Wuxi'],['无锡']],
    [['Nantong'],['南通']],
    [['英国伦敦'],['伦敦']],
    [['加利福尼亚州·库尔弗城'],['库尔弗城']],
    [['西雅图','圣保罗','利雅得','森尼韦尔','墨西哥城','雅加达'],['西雅图','圣保罗','利雅得','森尼韦尔','墨西哥城','雅加达']],
  ]){
    const r=normalizeLocations(raw);assert.deepEqual(r.cities,expected,raw.join('|'));
    assert.equal(r.unknown,false,raw.join('|'));assert.deepEqual(r.raw,raw);assert.ok(r.structured_evidence.length);
  }
  const unresolved=normalizeLocations(['China, Hebei, Multiple Locations']);
  assert.deepEqual(unresolved.cities,[]);assert.equal(unresolved.unknown,true);
  assert.deepEqual(normalizeLocations(['Londonville','Xiangtan','NotShanghai']).cities,[]);
});

test('新结构化解析也不能从大学、公司、采访和面试地点提取城市',()=>{
  for(const raw of [
    '中山大学','武汉大学','Shanghai University','Beijing University, Shanghai',
    'Shanghai Electric Company','Interview: Shanghai','采访地点：武汉','宣讲会：北京',
    '全国招聘会-上海站','远程面试','上海交通大学/北京大学',
  ]){
    const r=normalizeLocations([raw]);assert.deepEqual(r.cities,[],raw);assert.deepEqual(r.special,[],raw);
  }
  assert.deepEqual(normalizeLocations(['上海市南京西路']).cities,['上海']);
  assert.deepEqual(titleCities('采访地点：北京'),[]);
});

test('非空省份字段不阻止正文明确工作城市，保留省份原始值和正文依据',()=>{
  const r=normalizeJobLocations({title:'工程师',locations_raw:['广东省'],description:'工作城市：广州/深圳\n岗位职责：开发软件。'});
  assert.deepEqual(r.cities,['广州','深圳']);assert.equal(r.unknown,false);assert.deepEqual(r.raw,['广东省']);
  assert.deepEqual(r.description_evidence,['广州/深圳']);
  assert.ok(r.structured_evidence.some(e=>e.source==='description'&&e.resolves?.includes('广东省')));
  const conflict=normalizeJobLocations({locations_raw:['广东省'],requirements:'办公地点：武汉'});
  assert.deepEqual(conflict.cities,['武汉']);assert.deepEqual(conflict.unresolved,['广东省']);
  const unknown=normalizeJobLocations({locations_raw:['广东省'],description:'总部位于广州。\n面试地点：深圳。'});
  assert.deepEqual(unknown.cities,[]);assert.equal(unknown.unknown,true);
});

test('已有部分城市也保留正文列出的其他城市，不覆盖原始地点字段',()=>{
 const r=normalizeJobLocations({locations_raw:['深圳','北京'],description:'工作地点：南宁、北京、深圳'});
 assert.deepEqual(r.cities,['深圳','北京','南宁']);assert.deepEqual(r.raw,['深圳','北京']);
 const bodyOnly=normalizeJobLocations({locations_raw:[],description:'工作地点：深圳'});
 assert.deepEqual(bodyOnly.raw,[]);assert.deepEqual(bodyOnly.cities,['深圳']);
});
test('已有明确原文依据的Whitestown和漠河使用原名，不改写行政区划',()=>{
 assert.deepEqual(normalizeLocations(['Whitestown']).cities,['Whitestown']);
 assert.deepEqual(normalizeLocations(['大兴安岭地区-漠河县']).cities,['漠河']);
});
