import {datasetPath} from '../../../../shared/job-search-core/registry.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {INDUSTRIES} from './lib/industry-routing.mjs';
import {SKILL_ROOT} from './lib/io.mjs';
import {loadCompanyContext} from '../../../../shared/job-search-core/scripts/lib/company-records.mjs';

const {registry,records}=await loadCompanyContext();
const cityData=JSON.parse(await fs.readFile(path.join(SKILL_ROOT,'data/company-city-index.json'),'utf8'));
const cities=new Map(cityData.companies.map(item=>[item.company_id,item.cities||[]]));
const updated=(records.generated_at||new Date().toISOString()).slice(0,10);
let output=`# 行业公司索引\n\n截至 ${updated}，共 **${registry.companies.length} 个公司／招聘主体**，覆盖 ${INDUSTRIES.length} 个行业宽类。跨行业主体在运行时按公司 ID 去重。\n\n行业先分流，再按保存的城市标签硬筛。没有已确认城市不等于没有招聘；不使用总部地址填补岗位地点。接口可访问也不等于当前有正式校招。\n\n来源名单只收录经过主体与接口校验的配置，并区分完整 JD、完整列表、零岗位 API 和动态列表契约；校招城市来自已保存岗位地点，不代表此刻仍有开放岗位。验证日期和当次采集覆盖分别记录。\n\n`;
for(const industry of INDUSTRIES){
  const companies=registry.companies.filter(company=>(company.industry_tags||[]).includes(industry.id)).sort((a,b)=>a.display_name.localeCompare(b.display_name,'zh-CN'));
  output+=`## ${industry.label}（${companies.length}）\n\n| 公司／招聘主体 | 已保存校招城市 | 招聘入口 |\n| --- | --- | --- |\n`;
  for(const company of companies){
    const saved=cities.get(company.company_id)||[];
    const cityLabel=saved.length?saved.join('、'):'暂无已确认城市';
    output+=`| ${company.display_name.replace(/\|/g,'\\|')} | ${cityLabel.replace(/\|/g,'\\|')} | [招聘站](<${company.primary_entry_url}>) |\n`;
  }
  output+='\n';
}
await fs.writeFile(path.join(SKILL_ROOT,'data/行业公司索引.md'),output);
console.log(JSON.stringify({companies:registry.companies.length,industries:INDUSTRIES.length,output:path.join(SKILL_ROOT,'data/行业公司索引.md')},null,2));
