# Tamaki

一个轻量的 QQ 群机器人框架：通过正向 WebSocket 对接 [NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot v11），只服务少数群聊。

> 仓库只包含框架、脚本和文档示例。具体角色的 persona、台词、记忆、印象、译文都保存在本地 `data/`，不会上传到 git。

当前架构的重点：

- **消息只存一份**：群消息统一进 `messages`，用 `sessions` 记录“角色在线时间”，查询时 JOIN 过滤。没有每个角色一份消息。
- **语料库可多个，角色可绑定多个**：`data/corpora/<id>/corpus.db` 一个语料库一个 DB；角色 `meta.json` 的 `corpora` 列出绑定关系，检索时跨库合并。
- **角色卡与语料库同级**：都在 `data/` 下，定义与运行时数据分开。
- **角色靠目录扫描**：`src/character/loader.ts` 扫描指定文件夹，代码里不出现任何具体角色。
- **全局协议在代码里**：`src/context/builder.ts` 的 `PROTOCOL` 常量直接作为系统提示词第一段，不再读外部 md。
- **记忆按角色隔离**：`memories` / `summary_cursor` 带 `character_id`，每个角色只看到自己在线期间的群聊。

## 环境要求

- Node.js 24+
- pnpm（或 npm / yarn）
- 已登录 QQ 的 NapCat，开启正向 WebSocket
- 一个 OpenAI 兼容的 Chat Completions 接口

## 快速开始

```bash
pnpm install
cp .env.example .env
# 编辑 .env：BOT_QQ / ADMIN_QQ / ALLOWED_GROUPS / LLM_API_KEY

# 1. 本地角色：按下方「角色卡」示例创建
mkdir -p data/characters/example
# data/characters/example/meta.json
# data/characters/example/persona.md

# 2. 本地语料库：按下方「语料库」示例创建
mkdir -p data/corpora/example-corpus/raw
# data/corpora/example-corpus/meta.json
# 把日文 CSV 放到 data/corpora/example-corpus/raw/adv/...

# 3. 导入日文剧情
pnpm import:corpus -- --corpus example-corpus

# 4. 选择角色
mkdir -p data/runtime
echo example > data/runtime/active-character.txt

# 5. 启动
pnpm start
```

NapCat 侧需要：

1. 用与 `BOT_QQ` 相同的 QQ 登录
2. 开启正向 WebSocket，端口与 `WS_URL` 一致
3. 监听 `0.0.0.0` 时通常要配 token，把同一个值填到 `.env` 的 `WS_TOKEN`

> `data/` 整个目录被 gitignore。语料、会话、记忆、印象、翻译都不会上传到仓库。

## 目录结构

```text
Tamaki/
├── data/                           # 整个目录 gitignore
│   ├── characters/<id>/
│   │   ├── meta.json               # id / displayName / corpora 绑定
│   │   ├── persona.md
│   │   └── glossary.json
│   ├── corpora/<corpus-id>/
│   │   ├── meta.json
│   │   ├── corpus.db               # lines + translations + line_meta
│   │   ├── raw/adv/...             # 日文原始 CSV
│   │   └── curated/<character>.csv # 精选注释（可选）
│   └── runtime/                    # 全部可变运行时状态
│       ├── bot.db                  # sessions + messages + memories + cursor
│       ├── active-character.txt
│       ├── logs/bot-YYYY-MM-DD.log
│       └── <character>/
│           ├── memory/group_*.md
│           └── impressions/group_*.md
│
├── scripts/
│   ├── import-corpus.ts
│   ├── translate-corpus.ts
│   ├── mock-napcat.ts
│   └── e2e.ts
│
└── src/
    ├── character/
    │   ├── loader.ts               # 扫描角色/语料库目录、active 选择、fallback
    │   └── corpus.ts               # 单库查询 + 多库合并
    ├── context/builder.ts
    ├── store/
    │   ├── db.ts                   # 单份 messages/sessions/memories/cursor
    │   ├── messages.ts             # session 归属 + SQL 查询
    │   ├── memory.ts               # 长期记忆 + memories 表
    │   └── impressions.ts          # 群友印象 MD
    ├── memory/summarizer.ts
    ├── tools/
    │   ├── registry.ts
    │   ├── runner.ts
    │   └── builtin.ts
    ├── config.ts
    ├── log.ts                     # 控制台 + 按天文件日志
    ├── guard.ts
    ├── handler.ts
    ├── index.ts
    ├── llm.ts
    ├── types.ts
    └── ws.ts
```

## 消息与会话

`data/runtime/bot.db` 里：

`messages` 通过 `is_self` 区分人类和 bot；提供 `human_messages` / `bot_messages` 两个视图，并加了 `(is_self, created_at)` 索引，不需要拆第二个数据库。

```sql
sessions(id, character_id, started_at, ended_at, last_seen_at)

messages(
  id, message_id, session_id, self_id, post_type, message_type,
  group_id, user_id, nickname, is_self, raw_message, segments, created_at
)

memories(id, character_id, scope, version, content, created_at)
summary_cursor(character_id, scope, last_ts)
```

- 启动时关闭上次遗留的 open session，然后给当前角色插入新 session
- 运行中每 60 秒、以及每条消息到达时更新 `last_seen_at`
- 退出时写 `ended_at`
- 每条消息只写一行，带 `session_id`
- 查上下文：

```sql
SELECT m.*
FROM messages m
JOIN sessions s ON s.id = m.session_id
WHERE s.character_id = ?
  AND m.group_id = ?
  AND m.created_at >= ?
ORDER BY m.created_at, m.id;
```

因此：

- 角色只能看到自己 session 覆盖的群消息
- 同一角色重启后继续用旧 session，历史连续
- 换角色后，新角色看不到旧角色的在线期间
- 崩溃时最多把最后 60 秒算作在线
- 切换角色是启动时读 `data/runtime/active-character.txt`，需要重启

## 记忆与印象

两者是分开的：

- **长期记忆（客观事实）**：`MemoryStore` 管，写在 `data/runtime/<character>/memory/*.md`，同时把版本写进 `bot.db.memories`；由 summarizer 更新，有 cursor。只记可核对的事件、约定、明确偏好，不写性格评价
- **群友印象（主观判断）**：`ImpressionStore` 管，写在 `data/runtime/<character>/impressions/group_<gid>.md`，按群友小节维护；由 `update_impression` 工具更新，不写 `memories` 表。允许模糊、过时、被修正

`context/builder.ts` 组装 prompt 时分别读 `## 长期记忆（客观事实）` 和 `## 群友印象（主观判断，可能不准确）`，不会混在一个文件里；回复时明确提醒印象只作参考。

## 角色与语料库

### 角色卡

`data/characters/<id>/meta.json`：

```json
{
  "id": "example",
  "displayName": "示例角色",
  "corpora": [
    { "id": "example-corpus", "speakers": ["示例角色"] },
    { "id": "another-corpus", "speakers": ["示例角色（别称）"] }
  ],
  "aliases": ["示例"],
  "relations": {
    "{user}": "制作人",
    "角色A": "同龄",
    "角色B": "年长"
  }
}
```

- `corpora`：一个角色可以绑定多个语料库，每个绑定有自己的 `speakers`
- `speakers`：该语料库里属于这个角色的原始说话人名字
- `aliases`：保留给后续使用，不自动触发
- `relations`：把 `partner` 映射成 制作人/同龄/后辈/家人/对手/年长/粉丝/陌生人
- `glossary.json`：翻译术语表

`persona.md` 示例：

```markdown
# 角色

你是示例角色。写身份、性格、说话方式、关系与边界。

# 示例

群友：今天怎么样？
示例角色：还行，刚才在忙。
```

`glossary.json` 示例：

```json
{
  "プロデューサー": "制作人",
  "お金": "钱"
}
```

### 语料库

`data/corpora/<corpus-id>/`：

```text
meta.json       # 语料库元数据
corpus.db       # lines / translations / line_meta
raw/adv/...     # 日文原始 CSV
curated/*.csv   # 精选注释
```

`meta.json` 示例：

```json
{
  "id": "example-corpus",
  "displayName": "示例语料库"
}
```

`corpus.db` 表：

```sql
lines(id, scene, seq, speaker, text_ja, scene_type, partner)
translations(line_id, text_zh, source, model, updated_at)
line_meta(line_id, relation, tags, emotion, note, kind)
```

- `lines`：从该语料库的 `raw/adv/**/*.csv` 导入，一行一条
- `partner`：同场景最近的非本人说话人，用于推断关系
- `line_meta`：精选台词的关系、标签、情绪、备注
- `translations`：默认**留空**，由翻译脚本写入

导入：

```bash
# 默认读 data/corpora/<id>/raw，写 data/corpora/<id>/corpus.db
pnpm import:corpus -- --corpus example-corpus

# 合并某角色的精选注释
pnpm import:corpus -- --corpus example-corpus \
  --curated data/corpora/example-corpus/curated/example.csv \
  --character example
```

`--character` 会读取 `data/characters/<id>/meta.json` 中对应 corpus 的 `speakers`，用来匹配精选台词。

### 多语料库检索

- 每个 `CorpusStore` 只查自己的 DB
- `CorpusLibrary` 把绑定的多个库的检索结果合并、按分数排序、按 `corpusId + 日文` 去重
- `search_lines` 返回的每条结果都带 `corpusId`
- 上下文按 `corpusId` 分发回对应语料库取前后行
- 加新语料库 = 加一个 `data/corpora/<id>/` + 导入；角色 `corpora` 里加一条绑定

## 翻译

译文不存在仓库里，由脚本写入各语料库的 `translations` 表：

```bash
# 只查看会发什么，不调 API
pnpm translate -- --character example --corpus example-corpus --dry-run

# 实际翻译（需要 .env 里的 LLM_API_KEY）
pnpm translate -- --character example --corpus example-corpus --batch 40
pnpm translate -- --character example --corpus example-corpus --limit 100
pnpm translate -- --character example --corpus example-corpus --force
```

- 角色只绑定一个 corpus 时 `--corpus` 可省略
- 按绑定的 `speakers` 找缺失翻译
- 同一句日文只翻一次，再映射回多个 line id
- 每批写库，断点续跑
- 术语表参与 prompt

## 启动流程

1. `loadCharacterRegistry()` 扫描 `CHARACTERS_DIR/*/meta.json`
2. `loadCorpusRegistry()` 扫描 `CORPORA_DIR/*/meta.json`
3. 读 `data/runtime/active-character.txt`
4. 找不到 active 角色 → warn + 内置 fallback，不崩溃
5. 打开 `data/runtime/bot.db`，关闭旧 session，开始新 session
6. 按角色 `corpora` 绑定打开每个 `corpus.db`，构造 `CorpusLibrary`
7. 构造 `CharacterRuntime`，把 persona/corpus/memory/session 一起交给 builder 和 tools

## 日志

- 控制台和文件同时输出
- 文件：`data/runtime/logs/bot-YYYY-MM-DD.log`
- 默认级别 `info`；`LOG_LEVEL=debug` 会记录每条消息的 ID/类型、工具调用、LLM 耗时等，但**不记录聊天正文**
- `token / secret / password / authorization / api_key` 这类字段会被替换成 `[redacted]`
- 默认保留最近 7 个按天文件；`LOG_RETENTION_DAYS=0` 表示不清理
- `LOG_TO_FILE=0` 只输出控制台
- `scripts/import-corpus.ts`、`scripts/translate-corpus.ts` 仍是 CLI 输出，不写运行日志

## 配置

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `WS_URL` | 否 | `ws://127.0.0.1:3001` | NapCat 正向 WS 地址 |
| `WS_TOKEN` | 否 | 空 | NapCat 的 access token，以 `Authorization: Bearer` 发送 |
| `BOT_QQ` | 是 | — | 机器人 QQ |
| `ADMIN_QQ` | 是 | — | 管理员 QQ |
| `ALLOWED_GROUPS` | 是 | — | 允许的群号，逗号分隔 |
| `BOT_NAME` | 否 | 空 | 机器人昵称；留空则从 `get_login_info` 获取 |
| `LLM_API_KEY` | 是* | — | *`LLM_STUB=1` 时可不填 |
| `LLM_BASE_URL` | 否 | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `LLM_MODEL` | 否 | `deepseek-flash` | 模型名 |
| `LLM_STUB` | 否 | `0` | 本地自测用，不发网络请求 |
| `DATA_DIR` | 否 | `./data` | 运行时数据目录 |
| `CHARACTERS_DIR` | 否 | `$DATA_DIR/characters` | 本地角色定义目录 |
| `CORPORA_DIR` | 否 | `$DATA_DIR/corpora` | 本地语料库目录 |
| `ACTIVE_CHARACTER_FILE` | 否 | `$DATA_DIR/runtime/active-character.txt` | 当前角色文件 |
| `LOG_LEVEL` | 否 | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_DIR` | 否 | `$DATA_DIR/runtime/logs` | 日志目录 |
| `LOG_TO_FILE` | 否 | `1` | 设为 `0` 只输出控制台 |
| `LOG_RETENTION_DAYS` | 否 | `7` | 保留多少个按天日志；`0` 不清理 |
| `TZ_NAME` | 否 | `Asia/Shanghai` | 时区 |
| `SUMMARY_HOUR` | 否 | `3` | 定时总结小时，同时是上下文逻辑日界 |
| `SUMMARY_THRESHOLD` | 否 | `200` | 单会话累计多少条触发即时总结 |
| `WS_HEARTBEAT_TIMEOUT_MS` | 否 | `90000` | 心跳超时 |
| `WS_RECONNECT_DELAY_MS` | 否 | `3000` | 重连间隔 |

## 命令

```bash
pnpm start             # 启动
pnpm mock              # 单独启动 mock NapCat（默认 3099）
pnpm e2e               # 端到端自测（35 项断言）
pnpm typecheck         # tsc --noEmit
pnpm import:corpus     # 日文 CSV -> data/corpora/<id>/corpus.db
pnpm translate         # 翻译缺失台词，写入 translations
```

## 内置工具

| 工具 | adminOnly | 说明 |
|---|---|---|
| `update_impression` | 否 | 更新当前角色对某个群友的主观印象小节 |
| `search_memory` | 否 | 检索当前角色的长期记忆 |
| `search_lines` | 否 | 跨角色绑定的多个语料库检索台词，返回原文/已有中文/关系/标签/corpusId |

`adminOnly` 工具在 `listToolSchemas()` 阶段对非管理员不可见，执行前二次检查。

## 已知边界

- 同一时刻只有一个 active character；切换需要重启
- 角色只能看到自己在线期间的群消息；未激活期间的群聊不会进它的 DB
- 崩溃收尾按最后心跳计算，最多误差 60 秒
- 多语料库检索是关键词/子串 + 简单加权，不做语义检索
- `tags`/`emotion` 主要来自精选注释；原始行通常只有 `partner`/`relation`
- 翻译默认留空；不跑翻译脚本时中文检索只能命中已有 `text_zh`
- 语料、译文、记忆、印象都不进 git；重新 clone 后需要重新导入
- 没有插件系统、事件总线、多平台适配器

## License

MIT，见 [LICENSE](./LICENSE)。
