# 命令与运行约定

以下命令在仓库根目录执行。路径含空格时加引号。数据库默认为 `job-radar/state/radar.sqlite`，配置放在同目录；日报在 `job-radar/outputs/`。这些个人数据被 Git 忽略，不放共享来源库。

```sh
node job-radar/scripts/radar.mjs industries
node job-radar/scripts/radar.mjs catalog --query 游戏
node job-radar/scripts/radar.mjs subscribe --file job-radar/state/my-watch.json
node job-radar/scripts/radar.mjs list
node job-radar/scripts/radar.mjs runs --id game-pm
node job-radar/scripts/radar.mjs run --id game-pm
node job-radar/scripts/radar.mjs report --id game-pm --limit 30
node job-radar/scripts/radar.mjs pause --id game-pm
node job-radar/scripts/radar.mjs resume --id game-pm
```

## 订阅格式

agent 根据用户意图创建 JSON。示例用于解释字段，不能当作真实用户要求直接订阅：

```json
{
  "id": "game-pm",
  "name": "上海游戏项目管理",
  "mode": "social",
  "keywords": ["项目管理", "项目经理", "制作管理"],
  "exclude_keywords": [],
  "industries": ["all"],
  "business_filters": ["游戏研发", "游戏发行"],
  "business_filter_match": "any",
  "company_ids": [],
  "cities": ["上海"]
}
```

示例关注游戏研发或发行公司；游戏属于业务细分，宽行业使用 `industries` 返回值。业务词表与求职共用 `business-taxonomy.json`，`any` 命中任一项、`all` 同时命中；别名和上级标签使用同一匹配规则。`company_ids` 使用 catalog 的真实 ID。条件间取交集；空岗位词表示不限标题，空公司表示条件范围内全部已收录公司。至少设岗位词、具体行业、业务或公司之一，招聘方向必填。旧订阅缺少业务字段时继续不限业务。修改条件建立新版本基线，配置不包含简历或用户能力事实。

可先运行 `node job-radar/scripts/radar.mjs catalog --businesses 游戏研发,游戏发行 --business-match all`。雷达和求职都读取正式公司画像；Demo 标签可用于筛选，结果保留业务状态，日常运行不自动搜索或修正标签。

公司名、行业尚未收录时，说明覆盖边界。此版本不自动发现外部公司、不添加新的采集器。新增来源需单独按共享维护流程验证。每日搜索是对已收录来源的最新公开岗位检索，不声称覆盖全网。

## 调度

创建定时任务前运行首轮，确认命令和数据库路径有效。定时提示词示例（替换占位内容，不把占位符原样保存）：

> 使用位于「仓库绝对路径/job-radar/SKILL.md」的 job-radar skill。在仓库绝对路径运行 `node job-radar/scripts/radar.mjs run --id 真实订阅ID`，读取命令返回的 Markdown 报告。保持既有关注条件，用用户指定时区展示日期。出现新增、更新、重新出现、本次未见或采集失败时，简洁报告变化、岗位链接和覆盖缺口；无变化且没有故障时保持安静。若用户已明确要求每日汇报，则每天发送本线程摘要。暂停的订阅跳过执行，不自动恢复。不要自动投递或联系招聘方。

时刻和时区保存在宿主调度配置，SQLite 不充当调度器。将返回的 automation ID 及时间配置保存在本地 `state/schedule-订阅ID.json`，便于更新／暂停／删除同一任务；不要向用户宣称机器离线时仍保证执行。暂停时同时暂停宿主任务和本地订阅；恢复同理。默认日报只回到当前会话，外部邮箱或飞书发送需用户明确要求。

## 存储与失败处理

SQLite 表：`subscriptions` 保存配置和版本；`runs` 保存每轮起止、配置快照及状态；`coverage` 保存公司级覆盖；`jobs` 保存每版本岗位最近内容及首次／最近发现时间；`events` 保存新增、更新、重新出现、未见时的正文快照，可回看任一运行。数据库使用 WAL、busy timeout 和单订阅运行唯一索引；不同订阅互不覆盖。

`run` 总是重新采集。每公司事务提交，所以中途退出时已采集记录仍可回看；后续新运行不会再次把这些岗位当首次发现，查看中断运行的报告以免漏读。通过 `report --run 运行ID` 回看完整或中断报告，`--limit` 增大条数，`--out 文件` 指定输出。`--timezone` 默认 Asia/Shanghai，应按用户真实时区覆盖。可用 `--db 文件` 隔离另一套本地库。

进程被强制终止时，数据库可能仍有 running 记录。先确认旧进程已退出，再用 `runs --id 订阅ID` 取得运行 ID，执行 `recover --run ID`，将该轮标为失败后重新 `run`；不要在旧采集仍运行时恢复。普通异常会自动记录为 failed。接口失败留在报告，不能解释成成功的空列表。

`run --max-pages 100 --timeout-ms 20000` 设置每个来源的分页上限和单请求超时；不是全任务时限。来源多时可能耗时较长，不隐藏截断、不自动缩减公司范围。离线回归验证命令：

```sh
node --test job-radar/scripts/tests/radar.test.mjs
```
