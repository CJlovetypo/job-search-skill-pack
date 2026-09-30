# 招聘方向与采集路由

每个招聘来源分别声明校招（`campus`）、社招（`social`）、实习（`internship`）关联的采集路由。同一个接口可供多个方向共用；不同参数、门户或 API 用不同路由表达。公司、来源和岗位 ID 保持各自含义。

## 配置

来源库 `schema_version: 3` 使用以下结构；版本包契约为 v2。旧来源库仍可读取。

```json
{
  "source_id": "example",
  "provider": "workday",
  "primary_entry_url": "https://example.wd1.myworkdayjobs.com/Careers",
  "api_config": {"origin": "https://example.wd1.myworkdayjobs.com", "tenant": "example", "site": "Careers"},
  "collection_routes": [{"route_id": "all", "adapter_route": "configured", "overrides": {}}],
  "recruitment_modes": {
    "campus": {"status": "legacy_unverified", "route_ids": ["all"], "scope": "per_job_type_required"},
    "social": {"status": "declared", "route_ids": ["all"], "scope": "per_job_type_required"},
    "internship": {"status": "legacy_unverified", "route_ids": ["all"], "scope": "per_job_type_required"}
  }
}
```

`overrides` 整体替换对应字段，不做深层合并。允许覆盖入口、API 配置、请求样例、匿名初始化请求、分页大小、项目类型和岗位链接模板。不得改变来源的公司、provider 或已明确的租户绑定；新增招聘主体或独立租户仍走来源审核。

`adapter_route: configured` 表示适配器直接执行已发布请求配置，运行时不再推测招聘方向或改写类型过滤器。尚有独立方向实现的适配器使用固定 `campus`、`social` 或 `internship`，只能被对应方向引用。

## 状态与证据

| 状态 | 含义 |
| --- | --- |
| `declared` | 已登记并核验该方向的路由关系；完整覆盖仍看独立证据 |
| `legacy_unverified` | 保留旧采集范围，方向关系尚待核实；可继续请求 |
| `not_supported` | 有公开证据明确该来源不覆盖此方向；必须有说明、证据 URL，且不关联路由 |

关系状态、接口健康、岗位方向、正文完整性、查询完整性分别记录。岗位招聘类型来自返回字段、项目或 JD 证据；入口名称、请求过滤器、全职安排不能单独证明社招或校招。采样零命中、故障、限流均不能自动转成 `not_supported`。

三方向的 `source-direction-validation.json` 和 `source-mode-capabilities.json` 都按 `source_id + route_id + 请求指纹` 关联。共享路由的请求配置只有一份，各方向保留自己的核验结论。核验日期来自原始证据；迁移、摘要生成与版本发布不会刷新这个日期。

## 运行与兼容

全量搜索、关键词搜索、城市刷新使用同一套路由展开逻辑。关键词能力只在当前路由证明有效时启用，否则回退列表采集与本地标题筛选。同租户岗位跨路由去重并保留路由来源；不同租户不能仅凭相同岗位编号合并。

请求或分类规则变化使受影响方向的缓存失效；名称、证明说明和归档路径变化不改变请求指纹。雷达继续使用既有基线重建机制，迁移首次运行不批量报告新增或下架。旧城市保留为历史观测，待对应方向刷新。

维护在私有 OPS 完成，通过既有版本包安装。旧核心不能消费新契约的数据包。公开产品不执行接口发现或写回正式配置。

## 核验顺序

先核对公司与租户、官网入口及请求参数的对应关系，明确独立频道还是共用岗位流。随后分别检查 API 健康、列表契约、JD 完整性，最后检查岗位返回的招聘方向。完整目标 JD 不能代替入口关系证明；某次没有目标岗位也不能推导入口不存在。

华为 configured 路由使用 `api_config.job_type`：`CR` 为校招与实习共用流，`SR` 为社招流。共用 CR 路由由岗位 `scenarioName` 分型。Workday 共用流范围受租户、站点与地域筛选约束，普通全职岗位没有方向证据时继续保留未知。
