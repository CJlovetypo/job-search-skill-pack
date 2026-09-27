# 公司字段复核与发布

规则版本：`2026-09-26-evidence-v1`。执行定义在 `scripts/lib/company-review-policy.mjs`；既有行业、业务词表、性质枚举、供应商优先级与组织规模模型继续有效。此流程用于明确触发的维护，日常求职和雷达仍只读正式画像。

## 能力分工

1. Agent 先读归档正文，判断主体、事实、时间、业务规则映射和冲突。原有标签、供应商回答、搜索摘要都不能冒充正文。
2. 同义词、单位或年份差异、分类边界和推理不足交给本地分析。规则没有定义的情况进入规则待定。
3. 明确缺失事实、缺正文、时效不足、主体缺口或本地无法解释的事实冲突，才建立补证请求。已知 URL 优先直接读取。
4. 每个补证请求说明缺失事实、已读材料、成功标准和停止条件；同一缺口最多两轮，仍受总额度限制。联网失败保留执行阻碍。
5. Agent 给逐项档位、理由及证据；程序计算分数并检查硬门槛。搜索供应商不决定最终标签，分数不替代语义判断。

## 字段证据口径

| 字段 | 复核重点 | 风险 |
| --- | --- | --- |
| 行业 | 从主体经营事实映射现有19类，不按招聘岗位职能推断 | 一般 |
| 业务标签 | 每个标签都有产品或服务正文支持，沿用词表 | 一般 |
| 所有制 | 控制关系、目标主体及既定供应商优先级；合资不默认归类 | 严格 |
| 总部国家 | 明确总部与目标主体，不以注册地址或地区办公室代替 | 严格 |
| 上市状态 | 目标法人及适用时点；未搜到不证明未上市 | 严格 |
| 业务概述 | 每项实质主张有依据，区分集团、法人、品牌 | 一般 |
| 产品服务 | 逐项支持，不把客户业务当作本公司产品 | 一般 |
| 客户 | 明确客户关系，区分合作方、供应商及客户 | 一般 |
| 业务地区 | 实际业务范围，不以招聘地点或办公室代替 | 一般 |
| 员工人数 | 数值、单位、日期和主体齐备；另判是否支持规模派生 | 严格 |
| 资本 | 注册资本、融资、上市分别表述；金额有币种、时间和主体 | 严格 |
| 主体关系 | 明确母子公司或控制关系，同品牌不等于法律关系 | 严格 |

描述中含数量、金额、股权、上市等敏感主张，审核者必须设置 `sensitive_claims:true`，按严格门槛审核。产品型号中的数字不自动成为统计主张。程序不能证明审核者没有漏列主张，必须在语义复核中检查整段内容。

## 评分及硬门槛

| 维度 | 允许档位 | 解释 |
| --- | --- | --- |
| I 主体 | 0 / 10 / 20 / 25 | 不匹配 / 仅名称相近 / 有可靠关联且限定范围 / 直接明确对应目标主体 |
| D 支持程度 | 0 / 15 / 25 / 30 | 不支持 / 仅间接线索 / 有限必要归纳 / 所有主张直接支持 |
| A 来源 | 0 / 5 / 15 / 20 | 不可核对 / 摘要或不明来源 / 可追溯可靠来源 / 原始披露或直接权威来源 |
| T 时间 | 0 / 5 / 10 / 15 | 无法解释 / 过旧或时期不清 / 适用于限定描述但日期不完整 / 日期与所述时期明确匹配 |
| C 冲突 | 0 / 5 / 10 | 实质冲突 / 尚未解释 / 已核查范围内无冲突或已解释 |

试评分起点：一般字段总分至少85，且 I≥20、D≥25、A≥15、T≥10、C=10；严格字段总分至少90，且 I=25、D=30、A≥15、T≥10、C=10。逐项理由和正文引用必填；程序不接受只有总分的“模型置信度”。

主体、事实支持、范围、时间、冲突、正文真实性、词表七项门槛必须全部通过。单一原始来源可以充分，多家供应商重复同一来源不加分。高分不能抵消错误主体、过期结论或未解决冲突。

这些分数是证据质量评分，**不是正确概率**。校准样本和验收样本按公司分离，每字段至少20条校准样本、30条验收样本。首版还要求每字段至少20个准入样本，整体及逐字段观察准确率均≥98%，且准入项硬门槛错误为0。这里的准确率以独立盲审为参考，盲审本身也可能出错。报告同时列出误放（评分准入、参考不接受）、误拒（评分拒绝、参考接受）及95% Wilson 下界，避免把小样本的100%当作保证。

准确率仅描述本次候选样本，不能推广为全库保证。同一公司多个字段可能相关，整体 Wilson 区间未做公司聚类调整，应结合逐字段结果解读；不同 Agent 也可能共享模型偏差。

划分时还要检查关联主体与别名；不同公司ID不能使同一正文同时进入校准组和验收组。原件校验会拦截正文哈希跨组重复。发现分组问题时，保留原始样本和改动记录，在查看结论前修正分组；若已查看结果，应另建未暴露的验收集。

参考结论应由另一个复核者盲审原件，不得用旧批准、模型自评分或更换审核者名字伪造独立性。程序从样本重新计算，不接受手填 `passed` 的总结。所有条件通过前，不能通过独立复核入口发布 `verified`；正式独立复核小批及后续发布都需要绑定通过校准的样本文件。经明确授权的首版发布可以用 `demo_unreviewed` 入库，但不能借此获得已核实状态。

每个样本包含 `company_id`、`field`、`split`（calibration/test）、`decision`、`assessment`、`document_ids` 和独立 `reference`；用 `review_file`、`review_sha256` 绑定真实原件复核记录。`reference` 保存审核者、时间、是否盲审、决策哈希、可否接受、硬门槛错误、理由及正文ID。正式预检另外验证这些样本的原件链，并固定其哈希；单元测试的虚构样本不能用作正式校准依据。

## 证据、批准与发布

`schema_version:2` 维护批次允许复用归档正文。每份正文保留真实 `fetched_at`、内容哈希、原件路径及哈希、主体依据、本次适用性说明。`reviewed_at` 与字段 `checked_at` 是本次实际判断时间；不能重写旧抓取日期制造新证据。事实日期单独放在 `as_of`。

内置搜索正文须与成功请求账本、文件及 SQLite 原件一致，并关联目标公司。请求关联其他主体时先调查关联错误；不按名称相似自动合并。供应商直读正文须能定位原始 `fetch_url_results`；结构化答案和搜索摘要不升级为正文。

```sh
node shared/job-search-core/scripts/company-records.mjs init --campaign ID --out job-search/artifacts/WORK --scope all --selection selection.json
node shared/job-search-core/scripts/company-records.mjs record --work job-search/artifacts/WORK --file review.json
node shared/job-search-core/scripts/company-records.mjs approve --work job-search/artifacts/WORK --file approval.json
node shared/job-search-core/scripts/company-records.mjs calibrate --file calibration-samples.json --out job-search/artifacts/WORK/calibration-report.json
node shared/job-search-core/scripts/company-records.mjs preflight --work job-search/artifacts/WORK --trial true
```

`selection.json` 使用 `{companies:[{company_id,requested_fields}]}`；`all` 包含API支持及旧标签，`gaps` 仅补缺，两种范围分别统计。批准清单逐字段绑定完整候选哈希、字段决策哈希、证据、规则及审核时间。`pilot` 限50家公司；`calibrated` 用于后续批次。两者都需提供 `calibration_file` 与 `calibration_sha256` 指向独立复核样本，不能指向汇总报告。

通过校准并完成审核后，重新生成正式预检，再发布：

```sh
node shared/job-search-core/scripts/company-records.mjs preflight --work job-search/artifacts/WORK
node shared/job-search-core/scripts/company-records.mjs publish --work job-search/artifacts/WORK
```

试运行预检的 `publishable:false` 不能用于发布。正式预检固定候选、批准、原件、各输入层及目标文件哈希，发布前重算；变化则重新预检。只替换批准字段及其必要规模派生，不夹带招聘源、城市或其他字段变化。规模派生使用更新后的实际依赖；`size_eligible:false` 在后续重建时继续生效。

独立复核入口只发布获准的已核实字段。未决字段留在维护队列，不能通过批量填写 `unresolved` 算作复核完成。首版发布入口可以把已搜索但没有可用事实的字段保存为明确占位，状态必须是 `demo_unreviewed`，后续仍进入复核队列。调查暂结需要真实材料范围、未决原因和恢复条件；未调查、规则待定、网络中断分别保留。历史未决正式结论仍可读取，未提交字段不受影响。

API与独立核实仍为不同渠道。通用重建发布器不能绕过批准入口新增或修改独立复核结论。评分和完整正文仅存私有维护资料；公开字段结构保持原白名单。

## 中断恢复

发布器先生成全部输出与备份，持有共同写锁，记录日志，再逐个原子替换并回读。跨文件写入不是数据库事务；进程中断可短暂留下混合版本，因此待恢复日志会阻止继续发布。正式画像在兼容文件之后切换。

```sh
node shared/job-search-core/scripts/company-records.mjs recover
node shared/job-search-core/scripts/company-records.mjs recover --mode rollback
node shared/job-search-core/scripts/company-records.mjs unlock
```

`recover` 只从已知前后哈希继续，外部输入改变时先回滚再重新预检。回滚同样拒绝覆盖第三方修改。`unlock` 只清除已退出进程的锁。相同已提交计划回读成功后返回原回执；数据后来变化则拒绝重放。普通求职读取不获取维护写锁。
