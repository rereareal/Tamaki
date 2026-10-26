# TODO

## 识图（Vision）

- [ ] V1：只处理当前消息里的图片
  - 最多 4 张，单张上限 8MB
  - 支持 `url` / `base64://`，失败回退 `[图片]`
  - `ChatMessage.content` 支持 OpenAI `image_url` 多段格式
  - 历史消息仍用 `[图片]`，避免重复传图
  - 需确认 `ds-flash` 的 vision 入参就是 OpenAI 兼容格式

## 语料

- [x] 精选 52 条人工中文导入 translations
- [x] 翻译时生成 tags / emotion 并写入 line_meta
- [x] 全量翻译 kotone 台词（6,630/6,630，0 失败）
- [x] tags / emotion 写入（6,630 条，30 条精选只有关系标签）

## 工具

- [x] `web_search`：复用 DeepSeek `/v1/tools/search`
- [x] `web_fetch`：复用 DeepSeek `/v1/tools/fetch`
- [x] 每次回答前由代码强制执行一次 `search_lines`
  - keyword = 当前消息文本（去掉 @/reply）
  - tags = 中文主题词推断
  - 结果作为系统提示的【预检索台词】注入
  - 不伪造 assistant(tool_calls)，避免 thinking mode 400
  - system prompt 不再重复注入参考台词

## 主动发言

- [x] P1：空闲概率 + 冷却 + 每小时上限（默认关闭，`PROACTIVE_ENABLED=1` 开启）
  - 后续可选：关键词触发 / LLM 判断
