# 共享来源与标签维护

job-search 的三个招聘方向共用 assets/sources.json、采集实现及公司业务、性质、规模资料。城市索引和招聘方向证明归共享 data/recruitment/<mode>；个人运行留在产品目录。日常匹配读取已保存资料，不自动启动全库维护。

## 主动维护入口

仅在明确要求维护公司标签/招聘城市时执行本节。普通找岗位、找最新岗位、标签缺项或首次运行均不触发维护。分类与来源标准见 [公司标签模型](company-label-model.md)。稳定标签固定复用，招聘城市可更频繁主动更新；不设隐含自动刷新或定时任务。

从仓库根目录执行：

```sh
# 只读盘点：输出已有行业目录、业务词表、证据缺口和三方向城市覆盖
node shared/job-search-core/scripts/company-maintenance.mjs audit --out shared/job-search-core/state/maintenance/company-label-audit.json
# 主动城市更新，写指定方向索引并保存旧索引（不受旧城市过滤排除）
node shared/job-search-core/scripts/company-maintenance.mjs cities --mode social --only 公司ID
# 性质维护默认仅预览；明确写入时附 --apply，沿用原维护器备份和优先级
node shared/job-search-core/scripts/company-maintenance.mjs ownership --source supplier
node shared/job-search-core/scripts/company-maintenance.mjs ownership --source waiqi
# 只读查看公司简介、人数和资本资料缺口（不会启动合并或改写历史线索）
node job-search/scripts/jobs.mjs company-profiles --mode social status
```

audit 不联网、不重标，输出不可覆盖且限定在 shared/job-search-core/state/maintenance。cities 的 --out 是显式指定的本地采集证据目录，默认 shared/job-search-core/state/city-refresh/<mode>，可搭配 --resume；ownership 的 --out 为 shared/job-search-core/state/maintenance 内的独立证据目录。原 refresh-cities 与独立维护脚本仍可在明确维护任务中使用。业务/行业维护按证据逐项更新，分类词表迁移另行审核。

catalog/prepare 不初始化城市索引，collect（包括 --refresh）不更新共享标签；prepare/render 不将性质缺口变成必须维护的阻塞。unknown 保持未知，不能为继续使用伪造 verified。

用户要求扩容或修复时，先阅读 [来源准入与主体核验](../../../job-search/runtime/campus/references/source-maintenance.md)。默认核验真实 API 完整 JD、稳定岗位 ID、具体链接、主体依据、验证日期和分页范围；零岗位 API、公开列表能力使用独立准入状态，不能冒充完整 JD。只维护公司和接口时，优先查询 [Waiqi 接口资产](waiqi-sources.md#公司接口资产与扩源)，不为通过完整 JD 门槛擅自扩抓岗位详情。暂时没有目标方向岗位与来源无法访问是不同状态，不据此停用来源。

公司性质优先采用旧库供应商的结构化性质字段。运行 `scripts/tag-supplier-ownership.mjs` 预览，确认后用 `--apply` 全量刷新；“民营企业”“央国企”“外企”分别映射为私企、国企、外企，互相冲突的多选保留待核实，无法映射的事业单位或混合性质保持原记录。该脚本同步重算公司规模派生数据，并保留被覆盖结论的历史。

外企候选入口另存于 `assets/waiqi-source-candidates.json`，由 Waiqi 公开公司页及招聘链接形成线索库。维护时用 `scripts/source-candidates.mjs` 查询与导出，具体命令见 [Waiqi 候选查询](../../../job-search/runtime/campus/references/source-maintenance.md#waiqi-候选查询)，采集与证据说明见 [Waiqi 来源维护](waiqi-sources.md)。没有供应商明确结论时，Waiqi 公司详情明确标注“外企”可用 `scripts/tag-waiqi-ownership.mjs --apply` 更新已可靠关联的维护主体；脚本会跳过已有供应商权威结论。“合资”、仅目录收录和待审核的同租户提示不参与 Waiqi 打标。招聘来源仍须完成接口能力与主体核验后再纳入正式来源。

新增 Waiqi 发现并经官网核验的来源后，可离线补种三个招聘方向的城市索引：从仓库根目录运行 `node shared/job-search-core/scripts/seed-waiqi-city-index.mjs`。默认仅在本轮 `city-seed/` 生成计划、三方向补丁及官方 JD 证据汇总，不改现有索引；可用 `--input=` 指定该轮存有官方 admitted 清单的归档目录。来源正式合并后加 `--apply` 才将最小增量写入索引，并保留旧索引备份。补种复用日常招聘类型审查、目标 API 证据核对、城市规范化和跨入口冲突规则，仅使用官方开放岗位，不采用第三方城市提示。此为历史样本补充，覆盖始终标为 partial，保留旧城市；没有已证实招聘类型或地点的方向保持空或 unknown，不能宣称已完成全量城市刷新。

全库城市刷新：从仓库根目录运行 node shared/job-search-core/scripts/refresh-cities.mjs --mode campus --concurrency 2；mode 也可为 internship、social。指定相同 --out 并加 --resume 按配置指纹续跑，非完整结果会重试。不要同时对三个方向启动密集刷新；共享 ATS 平台也可能按 IP 限流，分租户并发限制不等于整个平台限速。

每家公司默认最多 180 次请求和 60 秒，Workday/SmartRecruiters 最多补取 20 个详情用于确认岗位类型。未取全时记部分覆盖；失败和部分采集保留历史城市。原始结果留在 artifacts，索引只保留摘要及少量地点例证。维护前确认 Python 等必要依赖可用。

更新共享库后，可运行 node shared/job-search-core/scripts/refresh-registry-metadata.mjs 刷新派生摘要；运行直接读取共享库，不依赖复制。node job-search/runtime/campus/scripts/render-industry-index.mjs 更新可阅读的公司索引。

Waiqi 深度核验来源按已审核的官方主体名称与 Waiqi 公司 ID 共同归并；必须同时具备主体核验结论、依据和证据文件。仅同名、同域名或同供应商 ID 不足以合并。一个主体的不同招聘站点仍保留独立接口配置及能力范围；多个现有主体同时命中时停止自动归并，人工核对。已完成的重复主体归并记录见 `assets/company-identity-consolidations.json`，历史快照保留原 ID。

主体增删后运行 `node shared/job-search-core/scripts/sync-company-city-index.mjs --apply` 同步三个方向的索引成员；该操作不补造城市证据。完成派生摘要刷新后，运行 `node shared/job-search-core/scripts/render-source-coverage.mjs` 同时更新 README 行业计数与覆盖图，避免手工统计不一致。

员工规模、关键词能力和修复边界分别见 [规模模型](company-size-model.md)、[定向检索](targeted-search.md)、[接口修复](source-repair.md)。资料有缺口时保留待核实。只保存公开事实和非敏感的接口配置，不将个人登录态或内部调研表作为公开依赖。

新增或修复招聘 API 的维护顺序固定为：基础能力与主体核验 → 登记受影响配置 → 逐配置、逐方向验证定向能力 → 保存结论 → 收尾检查。命令和证据标准统一见 [定向能力验收](targeted-search.md#新增与修复来源的固定验收流程)。必须处理全部受影响项，不使用普通审计的抽测上限；不因定向未证实停用基本能力已验证的来源。
