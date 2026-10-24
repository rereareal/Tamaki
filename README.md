# Tamaki

一个轻量的 QQ 群机器人框架：通过正向 WebSocket 直接对接 [NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot v11），只服务一个或少数几个群，不引入 AstrBot 等重型框架。

- 15 个 TypeScript 文件，运行时依赖只有 `ws` 和 `openai`
- SQLite 用 Node 内置 `node:sqlite`，配置用 Node 内置 `--env-file-if-exists`，无需 dotenv
- 消息实时入库；定时/按阈值把对话压缩进 Markdown 记忆，已总结内容不重放
- 内置廉价风控、串行出站队列和 OpenAI function calling

## 功能

- **连接**：正向 WS、`echo` 配对、断线 3s 重连、90s 无心跳强制重连
- **风控**：群白名单 → 忽略自己 → 5s 去重 → 每用户 10s 最多 5 条
- **出站**：所有消息走同一条串行队列，间隔 = 300–800ms 随机 + 消息类型固定延迟（text 200 / image 800 / record 1500 / face 100）
- **持久化**：SQLite WAL，入站消息和 bot 回复都实时写入
- **上下文**：系统提示（人设 + 长期记忆 + 群友印象）+ 上次总结后的对话 + 当前新消息
- **记忆**：每天 `SUMMARY_HOUR` 定时总结 + 每会话累计 `SUMMARY_THRESHOLD` 条即时总结；写 MD、写 `memories` 版本、推进 cursor
- **工具**：OpenAI function calling 格式，最多 5 轮，单工具 10s 超时，`adminOnly` 双重校验
- **触发**：群里被 @、引用 bot 的消息、文本包含 bot 昵称；管理员私聊总是回复

## 环境要求

- Node.js 24+（需要 `node:sqlite` 和 `--env-file-if-exists`）
- pnpm（或 npm / yarn）
- 已登录 QQ 的 NapCat，开启正向 WebSocket，端口与 `WS_URL` 一致
- 一个 OpenAI 兼容的 Chat Completions 接口（默认按 `deepseek-flash` 配置）

## 快速开始

```bash
pnpm install

cp .env.example .env
# 编辑 .env，至少填 BOT_QQ / ADMIN_QQ / ALLOWED_GROUPS / LLM_API_KEY

pnpm start
```

NapCat 侧需要：

1. 用与 `BOT_QQ` 相同的 QQ 登录
2. 开启正向 WebSocket 服务，例如监听 `127.0.0.1:3001`
3. 确认 bot 与 NapCat 在同一台机器或网络可达

> NapCat 监听 `0.0.0.0` 时通常强制要求设置 token。此时在 WebUI 里设置 token，并把同一个值填到 `.env` 的 `WS_TOKEN`；如果 NapCat 和 Tamaki 在同一台机器，也可以继续监听 `127.0.0.1` 且不设 token。

可选：把人设写到 `data/persona.md`，不存在时使用内置默认人设。

## 配置

所有配置来自环境变量，启动时由 `src/config.ts` 校验。

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `WS_URL` | 否 | `ws://127.0.0.1:3001` | NapCat 正向 WS 地址 |
| `WS_TOKEN` | 否 | 空 | NapCat 配置的 access token，以 `Authorization: Bearer` 发送 |
| `BOT_QQ` | 是 | — | 机器人 QQ，需与 NapCat 登录号一致 |
| `ADMIN_QQ` | 是 | — | 管理员 QQ，唯一允许私聊的人 |
| `ALLOWED_GROUPS` | 是 | — | 允许的群号，逗号分隔 |
| `BOT_NAME` | 否 | 空 | 机器人昵称；留空则启动后从 `get_login_info` 获取 |
| `LLM_API_KEY` | 是* | — | *`LLM_STUB=1` 时可不填 |
| `LLM_BASE_URL` | 否 | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `LLM_MODEL` | 否 | `deepseek-flash` | 模型名 |
| `LLM_STUB` | 否 | `0` | 设为 `1` 时不发网络请求，返回可预测文本，便于自测 |
| `DATA_DIR` | 否 | `./data` | 数据目录 |
| `TZ_NAME` | 否 | `Asia/Shanghai` | 时区 |
| `SUMMARY_HOUR` | 否 | `3` | 定时总结小时，同时是上下文“逻辑日界” |
| `SUMMARY_THRESHOLD` | 否 | `200` | 单会话累计多少条触发即时总结（含 bot 回复） |
| `WS_HEARTBEAT_TIMEOUT_MS` | 否 | `90000` | 多久没心跳强制重连 |
| `WS_RECONNECT_DELAY_MS` | 否 | `3000` | 断线重连间隔 |

> `SUMMARY_HOUR` 同时决定两件事：每天几点总结，以及上下文从几点开始算“新的一天”。例如 03:00 时逻辑日界是 03:00，凌晨 1–2 点的对话仍属于前一天，不会因为跨零点而失忆。

## 目录结构

```text
src/
├── index.ts              # 启动、连接、风控串联、消息入库、组装依赖
├── config.ts             # 环境变量读取与校验
├── types.ts              # OneBot v11 最小类型 + 消息段转文本
├── ws.ts                 # WS 连接、echo 配对、心跳、重连
├── guard.ts              # 白名单/自身/去重/限流 + 串行发送队列
├── llm.ts                # OpenAI 兼容客户端 + 本地 stub
├── handler.ts            # 触发判断、上下文组装、工具调用、回复
├── store/
│   ├── db.ts             # node:sqlite、WAL、建表
│   ├── messages.ts       # 消息读写、scope、逻辑日界
│   └── memory.ts         # 记忆/印象 MD、memories 版本、cursor
├── memory/
│   └── summarizer.ts     # 定时/阈值总结，写 MD 并推进 cursor
├── context/
│   └── builder.ts        # 系统提示 + 今日对话 + 当前消息
└── tools/
    ├── registry.ts       # Tool 接口与注册表
    ├── runner.ts         # function calling 循环、超时、错误回灌
    └── builtin.ts        # update_impression / search_memory
```

运行数据：

```text
data/
├── bot.db                        # SQLite（gitignored）
├── persona.md                    # 人设（gitignored）
├── memory/
│   ├── group_{gid}.md            # 群记忆
│   └── user_{uid}.md             # 私聊记忆
└── impressions/
    └── group_{gid}.md            # 群友印象簿
```

## 消息处理流程

```text
WS 事件
  └─ post_type === 'message'?
       ├─ 自己发的        → 丢弃
       ├─ 非白名单        → 丢弃
       ├─ 5s 内重复 id    → 丢弃
       ├─ 同用户超限流    → 丢弃
       ├─ 入库（同步）
       └─ handleMessage（异步）
            ├─ 是否触发：@ / 引用 bot / 含昵称 / 管理员私聊
            ├─ 组装上下文
            ├─ runWithTools（最多 5 轮）
            ├─ 串行队列发送
            └─ 检查阈值并可能总结
```

## 上下文与记忆规则

每次组装上下文只放三部分：

```text
系统提示 = 人设 + 长期记忆 MD + 群友印象 MD
历史消息 = 上次总结 cursor 之后的对话（没有 cursor 时回退到 SUMMARY_HOUR 逻辑日界）
新消息   = 当前这条
```

- 已总结进 MD 的对话不会再拼回上下文，避免重复计入
- 记忆 + 印象默认截断到 1500 字，今日对话默认 4000 字，超出时从最新往回保留
- 总结成功后才推进 cursor；总结失败时 cursor 不动，未总结对话继续留在上下文里

## 内置工具

| 工具 | adminOnly | 说明 |
|---|---|---|
| `update_impression` | 否 | 按 `user_id` 更新当前群某个群友的印象小节 |
| `search_memory` | 否 | 按关键词检索当前会话的长期记忆 |

`adminOnly` 工具在 `listToolSchemas()` 阶段对非管理员不可见，执行前还会二次检查。项目本身不内置管理员专属工具，需要时可自行 `registerTool()`。

## 自测

```bash
pnpm typecheck   # tsc --noEmit
pnpm e2e         # mock NapCat + stub LLM，端到端 22 项断言
pnpm mock        # 单独启动 mock NapCat（默认 3099）
```

`scripts/mock-napcat.ts` 模拟了 OneBot v11 的 action 响应、心跳、事件注入和断线；`scripts/e2e.ts` 覆盖白名单、自消息、去重、限流、串行发送、引用触发、私聊权限、上下文窗口、总结与 cursor、工具权限、token 请求头、重连和心跳超时。

## 已知边界

- 只实现用到的 OneBot v11 子集；未列出的消息段以宽松类型兜底
- 去重和限流是内存状态，重启后清空
- 同一时刻只支持一个 bot 实例；多实例需要各自独立的数据目录
- 图片/语音等媒体由 NapCat 处理，本项目只透传消息段
- 没有插件系统、事件总线、多平台适配器，这是刻意为之

## License

MIT，见 [LICENSE](./LICENSE)。
