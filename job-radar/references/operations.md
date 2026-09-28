# 命令与运行约定

命令从仓库根目录执行，路径含空格时加引号。默认数据库 `job-radar/state/radar.sqlite`，报告 `job-radar/outputs/`，原始采集证据 `job-radar/state/evidence/`。这些目录不随 Git 发布。

```sh
node job-radar/scripts/radar.mjs industries
node job-radar/scripts/radar.mjs catalog --query 游戏
node job-radar/scripts/radar.mjs subscribe --file job-radar/state/my-watch.json
node job-radar/scripts/radar.mjs list
node job-radar/scripts/radar.mjs run --id game-pm
node job-radar/scripts/radar.mjs runs --id game-pm
node job-radar/scripts/radar.mjs report --id game-pm --limit 30
node job-radar/scripts/radar.mjs pause --id game-pm
node job-radar/scripts/radar.mjs resume --id game-pm
```

## 订阅条件

Agent 根据实际用户选择整理配置，不要求用户手写 JSON。下面仅是格式示例，不能视为创建真实订阅的授权。

```json
{
  "id": "game-pm",
  "name": "上海游戏项目管理",
  "mode": "social",
  "roles": ["项目管理"],
  "keywords": ["项目管理", "项目经理"],
  "keyword_reasons": [
    {"keyword": "项目管理", "reason": "用户关注职能的直接表述"},
    {"keyword": "项目经理", "reason": "项目管理职能的常见岗位标题"}
  ],
  "retrieval": {"mode": "targeted", "selection": "explicit", "basis": "填写用户真实的标题定向选择"},
  "exclude_keywords": [],
  "industries": ["all"],
  "business_filters": ["游戏研发", "游戏发行"],
  "business_filter_match": "any",
  "company_ids": [],
  "cities": ["上海"]
}
```

招聘方向必填。公司范围至少明确行业、业务或公司之一；明确不限行业时记录 `scope_basis`。只有岗位目标不能推定不限行业。`company_ids` 用 catalog 的真实 ID；明确公司与其他硬条件冲突会报错。行业/业务订阅每次从最新正式数据选公司，明确公司清单保持固定。

`ownership_filters`、`headquarters_country_filters`、`listing_status_filters` 是可选硬条件。业务 any/all、别名、画像状态与求职一致；Demo 标签仍披露未独立核实。城市硬条件先查共享 `data/recruitment/<mode>/company-city-index.json`，再核对岗位；缺少单公司城市标签会排除，整个索引不可用则阻塞。`city_preference.importance: prefer/open` 不作硬排除，未指定城市不追问。

有岗位目标时，`retrieval.selection` 必须 explicit 或 inherited，basis 保留真实选择依据。无岗位目标可默认 exhaustive。标题定向要求 keywords 和逐词理由；全量用 roles 说明目标，不按标题词排除。定向按当前配置和方向的关键词证明优先 API 检索，未证实时完整列表后本地筛选。

同 ID、相同规范化配置重复保存不新增版本；条件变化建立新版本，旧历史保留，暂停状态不被 subscribe 恢复。日常运行只读正式画像、城市和来源配置；来源失败记录覆盖缺口，继续使用其他可用来源。用户可以反馈问题或更新正式版本。

## 全量 JD 审阅与续接

`run` 总是重新采集。无须职能审阅时自动完成；全量且有岗位目标时返回 `awaiting_review`、运行 ID 和待审数量。

```sh
node job-radar/scripts/radar.mjs review-export --run 运行ID --limit 20 --out job-radar/state/review-input.json
node job-radar/scripts/radar.mjs review-submit --run 运行ID --file job-radar/state/review-result.json
node job-radar/scripts/radar.mjs finalize --run 运行ID
node job-radar/scripts/radar.mjs report --run 运行ID
```

输出 items 含 JD 全文和绑定指纹。逐条阅读后提交 `{ "items": [...] }`；每条保留 job_key、job_fingerprint、target_fingerprint、rule_version，增加 status（related/unrelated/uncertain）、reason、evidence（本条 JD 的原文引文数组）。正文不足只能 uncertain；确定判断必须有引文。职能判断不生成个人能力分或投递建议。错指纹和冲突重复提交被拒绝，相同判断可重试。

未变 JD、目标和规则可复用判断；新岗位或正文改变重审。待审阻止同订阅新运行，不用旧基线推断消失。中断后继续原 run 的队列；finalize 可重复执行。未完成时报告明确披露待审，不能称完整日报。

## 历史、覆盖与迁移

`run_context` 保存查询、选源、正式画像及城市快照；`staged_results` 保存本轮观测；`review_requests` / `relevance_reviews` 保存待办和可复用判断。完成后写 coverage/jobs/events。公司事务和阶段状态支持 finalize 中断续接；同订阅 running/awaiting_review/finalizing 只能有一轮。

只有同一可比较范围的完整采集才推断“本轮查询未见”，不等于下架。部分分页、失败、城市排除、无入选公司或配置变化不推断消失。定向未见仅针对已确认词表。岗位仍在但相关性变为不相关，单列“关注条件匹配变化”。源配置变化先重建比较基线。

旧数据库先只读预览，再迁移。原配置没有真实策略选择时保留为 needs_input，不默认定向。

```sh
node job-radar/scripts/radar.mjs migrate-preview
node job-radar/scripts/radar.mjs migrate --file job-radar/state/migration-decisions.json
node job-radar/scripts/radar.mjs migration-rollback --file 迁移回执.json
```

补充文件为数组，每项含订阅 id 及用户确认的 retrieval、必要 keyword_reasons/scope_basis。迁移前使用 SQLite 一致性备份；原订阅 ID、版本、启用/暂停状态和历史不变。重复执行幂等，运行中拒绝迁移。缺信息可先完成 schema 迁移，补齐后再次 migrate；首次采用新规则建立桥接基线，不批量重报历史岗位。回滚在事务内校验迁移后完整数据库内容，有新历史或配置修改则拒绝覆盖。

历史只读 list/runs/report 在迁移前仍可用。真实调度必须在订阅完成迁移后切换；保留原 automation ID、时区、通知偏好和暂停状态，不新建重复任务。

## 调度与故障

首次运行确认有效后使用宿主调度。只有工具确认创建/更新才报告已启用。保存实际 automation ID 和时间配置至 `state/schedule-订阅ID.json`；没有调度器时说明仍需手动执行。暂停同时处理本地订阅和对应宿主任务，恢复同理。

调度提示包含仓库绝对路径、订阅 ID 和如下流程：先读 runs；已有 awaiting_review/finalizing 则续接，否则 run。需要全文审阅时导出、逐条读全文并提交、finalize，再 report。遇到新增、实质变化、采集失败或首次需要处理的状态才通知；原因未变不重复提醒。用户要求每日汇报时沿用该偏好。暂停订阅跳过，不自动恢复；不自动投递或联系招聘方。

进程被终止留下 running 时，先确认旧进程已退出，再 `recover --run ID` 标记失败并重跑。awaiting_review 继续审阅，finalizing 继续 finalize。`--max-pages 100 --timeout-ms 20000` 是每来源页数和单请求超时，不是整个任务时限；不隐藏截断或缩减公司范围。report 支持 `--timezone`、`--out`，所有数据库命令可用 `--db` 指定隔离库。

离线验证：`node --test job-radar/scripts/tests/*.test.mjs`。
