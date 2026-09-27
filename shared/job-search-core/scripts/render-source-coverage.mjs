import fs from 'node:fs';
import {INDUSTRIES} from './lib/industry-routing.mjs';
import {loadCompanyContext} from './lib/company-records.mjs';

const {registry,records}=await loadCompanyContext();
const companies=registry.companies.length,configurations=registry.companies.reduce((n,c)=>n+(c.recruitment_sources?.length||1),0);
const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(records.generated_at));
const counts=INDUSTRIES.map(t=>({...t,count:registry.companies.filter(c=>c.industry_tags?.includes(t.id)).length}));
const number=n=>n.toLocaleString('en-US');
const readme=new URL('../../../README.md',import.meta.url);
let text=fs.readFileSync(readme,'utf8').replace(/[\d,]+ 个公司／招聘主体/g,number(companies)+' 个公司／招聘主体').replace(/[\d,]+ 个招聘接口配置/g,number(configurations)+' 个招聘接口配置').replace(/[\d,]+ 个接口配置/g,number(configurations)+' 个接口配置');
text=text.replace(/统计于 \*\*\d{4}-\d{2}-\d{2}\*\*/,`统计于 **${date}**`);
for(const t of counts){const label=t.label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const examples=registry.companies.filter(c=>c.industry_tags?.includes(t.id)).slice(0,3).map(c=>c.display_name.replaceAll('|','\\|')).join('、');text=text.replace(new RegExp(`\\| ${label} \\| [\\d,]+ \\| [^\\n]+`),`| ${t.label} | ${t.count} | ${examples} |`);}
fs.writeFileSync(readme,text);
const top=counts.sort((a,b)=>b.count-a.count).slice(0,10),title=`招聘来源覆盖：${number(companies)} 个公司／招聘主体、${number(configurations)} 个接口配置、${INDUSTRIES.length} 个行业大类`;
const bars=top.map((t,i)=>{const y=238+39*i,w=Math.round(570*t.count/top[0].count);return `<text x="58" y="${y+19}" class="label">${t.label}</text><rect x="360" y="${y}" width="${w}" height="24" rx="5" fill="url(#logo-blue)"/><text x="${372+w}" y="${y+18}" class="value">${t.count}</text>`;}).join('');
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1152" height="720" viewBox="0 0 1152 720" role="img" aria-labelledby="title desc"><title id="title">${title}</title><desc id="desc">展示覆盖主体数最多的十个行业。</desc><defs><linearGradient id="logo-blue" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#73ddf9"/><stop offset="45%" stop-color="#36adf4"/><stop offset="100%" stop-color="#1680eb"/></linearGradient></defs><style>.title{font:700 32px 'Microsoft YaHei','Noto Sans CJK SC',sans-serif;fill:#17446e}.sub{font:18px 'Microsoft YaHei',sans-serif;fill:#526f8a}.metric{font:700 38px 'Segoe UI','Microsoft YaHei',sans-serif;fill:#127adb}.metricLabel{font:15px 'Microsoft YaHei',sans-serif;fill:#526f8a}.label{font:17px 'Microsoft YaHei',sans-serif;fill:#234e72}.value{font:700 16px 'Segoe UI',sans-serif;fill:#0869ba}</style><rect width="1152" height="720" fill="#f1f9ff"/><text x="58" y="62" class="title">招聘来源覆盖</text><text x="58" y="94" class="sub">公开招聘接口与招聘主体的当前维护规模</text><text x="58" y="160" class="metric">${number(companies)}</text><text x="58" y="188" class="metricLabel">公司／招聘主体</text><text x="286" y="160" class="metric">${number(configurations)}</text><text x="286" y="188" class="metricLabel">招聘接口配置</text><text x="514" y="160" class="metric">${INDUSTRIES.length}</text><text x="514" y="188" class="metricLabel">行业大类</text><text x="58" y="224" class="sub">覆盖主体数最多的十个行业</text>${bars}<text x="58" y="684" class="sub">统计于 ${date} · 同一主体可属于多个行业</text></svg>\n`;
fs.writeFileSync(new URL('../assets/readme-coverage.svg',import.meta.url),svg);
console.log(JSON.stringify({companies,configurations,date}));
