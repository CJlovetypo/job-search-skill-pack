import fs from 'node:fs/promises';
import path from 'node:path';
import {csvCell} from './lib/waiqi-utils.mjs';

const root = path.resolve(process.argv[2] || 'shared/job-search-core/state/maintenance/waiqi-2026-09-20');
const read = async name => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
const summary = await read('summary.json');
const integration = await read('integration-result.json');
const city = await read('city-seed/cumulative-summary.json').catch(() => read('city-seed/apply-plan.json'));
const candidates = JSON.parse(await fs.readFile('datasets/recruitment-links/catalog/waiqi-source-candidates.json', 'utf8'));
const domains = new Map();
for (const company of candidates.companies) for (const link of company.recruitment_links) {
  const host = new URL(link.url).hostname;
  if (!domains.has(host)) domains.set(host, {host, companies: new Map(), urls: new Set(), jobs: 0, example: link.url});
  const item = domains.get(host);
  item.companies.set(company.waiqi_company_id, company.display_name);
  item.urls.add(link.url); item.jobs += link.job_ids.length;
}
const domainRows = [['招聘链接域名', '去重招聘链接数', '关联岗位数', '原站关联公司数', '原站公司名称（未经主体合并）', '链接示例'],
  ...[...domains.values()].sort((a,b) => b.jobs-a.jobs).map(d => [d.host, d.urls.size, d.jobs, d.companies.size, [...d.companies.values()].join('；'), d.example])];
await fs.writeFile(path.join(root, 'recruitment-domains.csv'), '\ufeff' + domainRows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
const providers = {};
for (const row of integration.added) providers[row.provider] = (providers[row.provider] || 0) + 1;
const fmt = n => Number(n).toLocaleString('en-US');
const rows = [['正式公司ID', '正式主体名称', '接口来源ID', '服务商', '招聘入口', '本次新增主体', '核验清单'],
  ...integration.added.map(r => [r.company_id, r.display_name, r.source_id, r.provider, r.entry, r.new_company ? '是' : '已有或已合并主体', r.input_file])];
await fs.writeFile(path.join(root, 'verified-official-sources.csv'), '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
const report = `# Waiqi 外企来源采集报告

全国目录入口：[waiqi.com/company](https://waiqi.com/company)。导出时间：${summary.generated_at}。

## 抓取结果

| 项目 | 数量 |
| --- | ---: |
| 网站报告公司总量 / 实际去重公司 | ${fmt(summary.reported_companies)} / ${fmt(summary.companies)} |
| 已取得公司详情 | ${fmt(summary.company_details_ok)} |
| 有外部招聘链接的公司 | ${fmt(summary.companies_with_external_links)} |
| 去重岗位记录 | ${fmt(summary.unique_jobs)} |
| 含可用外部链接的岗位 | ${fmt(summary.jobs_with_external_links)} |
| 去重外部招聘链接 | ${fmt(summary.unique_external_links)} |
| 已取得站内岗位详情 | ${fmt(summary.job_details_ok)} |
| 无可用外链、站内详情待续抓 | ${fmt(summary.job_details_pending)} |
| 抓取失败 / 岗位数量对账差异 | ${summary.failures} / ${summary.position_count_discrepancies} |

采集使用全国筛选和 100 条分页，未沿用网站默认北京筛选。逐公司核对岗位返回数；真实岗位列表响应 ${fmt(summary.position_lists_ok)} 份，其中 ${fmt(summary.zero_positions_confirmed_by_company_api)} 份返回空数组。所有原始响应均保留时间、请求与摘要。

完整保留公司介绍、别名、官网、福利及行业／性质／规模／城市线索。${fmt(summary.links_extracted_from_prefixed_text)} 条链接从“请在微信端打开”等前缀中提取，原始文本同时保存。无可用外部链接的岗位补取站内详情；其余岗位以列表信息和招聘原站链接为主，并未下载每个岗位的全文 JD。官方接口的完整 JD 样本另外留档。

## 已补入共享来源库

新增 **${fmt(integration.added_companies)} 个招聘主体、${fmt(integration.added_configurations)} 个官方 API 配置**。共享库从 ${fmt(integration.before_companies)} 个主体增至 **${fmt(integration.after_companies)} 个主体、${fmt(integration.after_configurations)} 个配置**，校招、实习、社招及岗位雷达共用。

${Object.entries(providers).map(([name, count]) => '- ' + name + '：' + count + ' 个配置').join('\n')}

准入依据包括匿名官方 API、真实完整 JD 样本、岗位 ID、招聘链接、主体证据、核验日期和行业路由。保留原有公司 ID 与用户资料；原站错配名称仅保留为来源线索，不能自动变成公司别名或资本性质。

从 ${fmt(city.archived_official_jobs)} 条归档官方岗位记录离线补充城市证据：

| 方向 | 新增城市覆盖的主体 | 新增城市归属条数 |
| --- | ---: | ---: |
${Object.entries(city.modes).map(([mode, data]) => '| ' + ({campus:'校招', internship:'实习', social:'社招'}[mode] || mode) + ' | ' + data.companies_with_new_cities + ' | ' + data.new_city_assignments + ' |').join('\n')}

城市证据按真实招聘方向、开放状态和地点审核，保留旧城市，统一标记部分覆盖。国家级 China 或远程岗位不会编造具体城市；没有方向证据时不拿社招岗位补校招。

## 交付文件

- [公司资料表](companies.csv)
- [全部岗位及招聘链接表](recruitment-links.csv)
- [本次正式接入的官方来源](verified-official-sources.csv)
- [招聘网站域名及关联公司汇总](recruitment-domains.csv)
- [岗位结构化记录](jobs.jsonl)
- [官方接口岗位样本](city-seed/official-jobs.jsonl)
- [抓取覆盖统计](summary.json)
- [正式来源合并记录](integration-result.json)
- [失败记录](failures.json)
- [站内详情待续抓清单](job-details-pending.json)
- [原有主体与配置保留检查](preservation-audit.json)
- [回归测试结果](tests-after-integration.txt)

持久候选库位于 datasets/recruitment-links/catalog/waiqi-source-candidates.json，包含全部目录公司，包括暂时零岗位或没有招聘链接的公司。维护、续抓与查询方法见 shared/job-search-core/references/waiqi-sources.md。

## 覆盖边界

本次完成的是该全国目录及其关联岗位、招聘链接的快照，不代表全市场外企目录。官网核验使用实际样本；没有岗位、无完整 JD、仅内部招聘、接口失败或主体不明的入口保留待核验，不强行加入正式采集库。链接存在不等于岗位目前仍开放，实际求职时需要重新查询。公司性质优先采用旧库供应商结构化字段；没有供应商明确结论时，Waiqi 公司详情的明确“外企”标注按维护规则更新公司性质。“合资”和规模标签仍只作线索。

${summary.job_details_pending ? '站内详情接口在补取阶段持续返回限流；遵守冷却并延长重试后仍未恢复，因此暂停补取，保留上述待续抓清单。全国公司资料和岗位列表均已完成。' : '无外链岗位的站内详情补取已完成。'}
`;
await fs.writeFile(path.join(root, '抓取报告.md'), report);
console.log(JSON.stringify({report: path.join(root, '抓取报告.md'), providers, companies: summary.companies, jobs: summary.unique_jobs}));
