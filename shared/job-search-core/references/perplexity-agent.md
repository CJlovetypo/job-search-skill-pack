# Perplexity 联网回答

主动研究入口使用官方 Node.js SDK `@perplexity-ai/perplexity_ai`，沿用 Node.js 22.13+、ESM 和内置 `node:test`。在共享核心目录管理唯一新增依赖及 npm lockfile：

```powershell
npm.cmd --prefix shared/job-search-core ci
```

密钥只从 `PERPLEXITY_API_KEY` 环境变量读取。请在 [API Console](https://console.perplexity.ai) 创建密钥并在自己的终端设置，切勿粘贴到聊天或提交仓库。项目根目录的 `perplexity secret.txt` 被 Git 忽略；程序不会自动读取它。测试时可在自己的 PowerShell 临时装载已有文档中的密钥，不输出内容：

```powershell
$env:PERPLEXITY_API_KEY = (Get-Content -Raw -LiteralPath '.\perplexity secret.txt').Trim()
node shared/job-search-core/scripts/perplexity-answer.mjs --smoke
Remove-Item Env:PERPLEXITY_API_KEY
```

上例要求文档仅含密钥。密钥若曾泄露，请在 Console 撤销并轮换。

若网络要求使用 `HTTP_PROXY` / `HTTPS_PROXY`，支持该选项的 Node.js 版本（例如本机 Node 25）可使用 `node --use-env-proxy ...`；标准 Node 22.13 不提供这个选项，需要可直连的网络或自行配置兼容代理传输。不要把代理凭据写入命令输出。

从仓库根目录调用：

```powershell
node shared/job-search-core/scripts/perplexity-answer.mjs --question '请查阅三六零官网，概述其主营业务并提供来源' --out shared/job-search-core/state/maintenance/perplexity/360-answer.json
node shared/job-search-core/scripts/perplexity-answer.mjs --company company-f93e5a384c54 --preset low
node shared/job-search-core/scripts/perplexity-answer.mjs --question '哪些来源直接支持这个结论？' --previous-response-id resp_FROM_PREVIOUS_RESULT
```

`--company` 只发送名称、别名和招聘 URL 等身份锚点，不发送旧标签或用户简历。结果默认输出 JSON；`--out` 限定在维护产物目录且禁止覆盖已有文件。不会自动改写正式公司标签，也不会在日常求职流程中隐式调用。

默认使用 `preset: low`、`web_search` 和 `fetch_url`，最多 5 个研究步骤、2048 输出 token。`--model` 可替代 preset；`--max-output-tokens` 可调整生成上限。预设由服务商动态维护，实际模型记录在结果中。调用按模型 token 和工具用量计费，返回的 `usage` 保留实际费用字段（如果 API 提供）。

程序通过 SDK 的 `output_text` 获取回答，单独保留 `search_results`、`fetch_url_results` 和文本 `annotations` 中的 URL 引用。`grounding_observed` 表示是否观察到检索/抓取结果，不代表事实全部核实；`review_state` 固定为 `answer_requires_independent_review`。生成回答和工具摘要不能直接冒充已有复核管线要求的原始网页正文。

多轮用返回的 `response_id` 作为下一次的 `--previous-response-id`。结构化输出可通过 `--schema 文件.json` 提供如下内容：

```json
{
  "name": "CompanyAnswer",
  "schema": {
    "type": "object",
    "properties": {"answer": {"type": "string"}, "uncertain": {"type": "boolean"}},
    "required": ["answer", "uncertain"],
    "additionalProperties": false
  }
}
```

请求发送为 `response_format: {type: "json_schema", json_schema: ...}`。返回 `structured_output` 为解析后的 JSON；消费者仍需按自己的业务约束验证字段。空回答、未完成状态及无效 JSON 会失败，不落盘为成功结果。

401 提示密钥认证失败。429 最多自动重试两次，遵守秒数或 HTTP 日期形式的 `Retry-After`；等待超过 60 秒时返回 `retry_after_ms`，交由调用者稍后重试，不提前重试。不记录 API 错误原文、授权头或 SDK 调试日志。网络故障、其他 HTTP 错误和超时直接失败，避免不明确的付费重试。

验证：

```powershell
npm.cmd --prefix shared/job-search-core run test:perplexity
npm.cmd --prefix shared/job-search-core test
node --check shared/job-search-core/scripts/perplexity-answer.mjs
node --check shared/job-search-core/scripts/lib/perplexity-agent.mjs
```

项目未配置 ESLint 或 TypeScript 类型检查；保留既有测试方式，无额外 lint/type 工具依赖。

官方依据：[文档索引](https://docs.perplexity.ai/llms.txt)、[Agent 快速开始](https://docs.perplexity.ai/docs/agent-api/quickstart)、[预设](https://docs.perplexity.ai/docs/agent-api/presets)、[工具](https://docs.perplexity.ai/docs/agent-api/tools/overview)、[结构化输出](https://docs.perplexity.ai/docs/agent-api/output-control)、[API 定义](https://docs.perplexity.ai/api-reference/agent-post)、[SDK](https://docs.perplexity.ai/docs/sdk/overview)、[费用](https://docs.perplexity.ai/docs/getting-started/pricing)、[限流](https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers)。Agent 正式路径为 `POST /v1/agent`，SDK 也可能使用官方支持的 `/v1/responses` 别名。
