import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockNapCat } from './mock-napcat';
import type { ChatMessage, LLMCall } from '../src/tools/runner';

const PORT = 3099;
const BOT_QQ = 10000;
const ADMIN_QQ = 123456;
const GROUP = 111;

const dataDir = mkdtempSync(join(tmpdir(), 'tamaki-e2e-'));
process.env.WS_URL = `ws://127.0.0.1:${PORT}`;
process.env.BOT_QQ = String(BOT_QQ);
process.env.ADMIN_QQ = String(ADMIN_QQ);
process.env.ALLOWED_GROUPS = String(GROUP);
process.env.LLM_STUB = '1';
process.env.LLM_API_KEY = 'stub';
process.env.DATA_DIR = dataDir;
process.env.TZ_NAME = 'Asia/Shanghai';
process.env.WS_HEARTBEAT_TIMEOUT_MS = '1500';
process.env.WS_RECONNECT_DELAY_MS = '3000';
process.env.SUMMARY_THRESHOLD = '200';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label: string, fn: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

let failed = 0;
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ${extra}`}`);
  if (!ok) failed++;
}

const callLLM: LLMCall = async (messages) => {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  if (system.includes('记忆整理器')) {
    return { role: 'assistant', content: '记忆：群友喜欢猫，约定周五打游戏。' };
  }
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  return { role: 'assistant', content: `收到喵：${lastUser}` };
};

const mock = new MockNapCat(PORT, BOT_QQ, 'Tamaki');
await mock.start();

const { start } = await import('../src/index');
const { buildContextMessages } = await import('../src/context/builder');
const { runWithTools } = await import('../src/tools/runner');
const { registerTool, listToolSchemas } = await import('../src/tools/registry');
const { scopeOf, startOfLogicalDay } = await import('../src/store/messages');
const { NapCatClient } = await import('../src/ws');
const { openDb } = await import('../src/store/db');
const { MessageStore } = await import('../src/store/messages');

const app = start({ callLLM });

try {
  await waitFor('ws connected', () => app.client.isOpen);
  await sleep(100);

  // 0. WS_TOKEN 通过 Authorization 头发送
  const tokenClient = new NapCatClient(`ws://127.0.0.1:${PORT}`, {
    token: 'secret-token',
    reconnectDelayMs: 60_000,
    heartbeatTimeoutMs: 60_000,
  });
  tokenClient.connect();
  await waitFor('token header', () => mock.lastAuthHeader === 'Bearer secret-token');
  check('WS_TOKEN 以 Authorization: Bearer 发送', mock.lastAuthHeader === 'Bearer secret-token');
  tokenClient.close();
  await sleep(100);

  const rows = () => app.store.getMessagesBetween(`group:${GROUP}`, 0, Date.now() + 1000);
  const sendCount = () => mock.actions.filter((a) => a.action === 'send_group_msg' || a.action === 'send_private_msg').length;
  const injectGroup = (id: number, user: number, text: string, extra: any[] = [], gid = GROUP) =>
    mock.inject({
      message_id: id,
      user_id: user,
      group_id: gid,
      message: [{ type: 'text', data: { text } }, ...extra],
    });
  const atBot = { type: 'at', data: { qq: String(BOT_QQ) } };

  // 1. 非白名单群
  const beforeBadGroup = rows().length;
  injectGroup(9001, 501, '不许进', [], 999);
  await sleep(250);
  check('非白名单群被忽略', rows().length === beforeBadGroup && !rows().some((r) => r.message_id === 9001));

  // 2. 自己的消息
  const beforeSelf = rows().length;
  injectGroup(9002, BOT_QQ, 'self');
  await sleep(150);
  check('机器人自己的消息被忽略', rows().length === beforeSelf);

  // 3. 未触发不回复，但正常入库
  injectGroup(9003, 501, '普通闲聊');
  await sleep(250);
  check(
    '群聊未 @ 时只入库不回复',
    rows().some((r) => r.message_id === 9003) && !mock.actions.some((a) => a.action === 'send_group_msg'),
  );

  // 4. @ 触发回复 + 出站入库
  const c1 = sendCount();
  injectGroup(9004, 502, '你好', [atBot]);
  await waitFor('reply to mention', () => sendCount() > c1);
  await sleep(100);
  const selfRows = rows().filter((r) => r.is_self === 1);
  check('@ 触发回复且写入 is_self 记录', sendCount() > c1 && selfRows.length >= 1);

  // 5. 去重
  injectGroup(9005, 503, 'dedup');
  injectGroup(9005, 503, 'dedup');
  await sleep(250);
  check('5 秒内重复 message_id 只处理一次', rows().filter((r) => r.message_id === 9005).length === 1);

  // 6. 限流：同一用户 10 秒 6 条 -> 只入 5 条
  for (let i = 0; i < 6; i++) injectGroup(9010 + i, 504, `flood-${i}`);
  await sleep(350);
  check(
    '同用户 10 秒超过 5 条被丢弃',
    rows().filter((r) => r.user_id === 504).length === 5,
    `actual=${rows().filter((r) => r.user_id === 504).length}`,
  );

  // 7. 串行发送 + 间隔
  const actionBase = mock.actions.length;
  for (let i = 0; i < 3; i++) injectGroup(9020 + i, 601 + i, `连发-${i}`, [atBot]);
  await waitFor('3 serial replies', () => mock.actionsSince(actionBase, 'send_group_msg').length >= 3);
  const sends = mock.actionsSince(actionBase, 'send_group_msg');
  const deltas = sends.slice(1).map((a, i) => a.ts - sends[i]!.ts);
  check(
    '发送串行且间隔 >= 300+200ms',
    deltas.length === 2 && deltas.every((d) => d >= 450),
    `deltas=${deltas.join(',')}`,
  );
  check(
    '串行顺序与消息顺序一致',
    sends.length === 3 && sends.every((a, i) => JSON.stringify(a.params.message).includes(`连发-${i}`)),
    JSON.stringify(sends.map((a) => a.params.message)),
  );

  // 8. 回复 bot 的消息也能触发
  const c2 = sendCount();
  mock.inject({
    message_id: 9030,
    user_id: 605,
    group_id: GROUP,
    message: [
      { type: 'reply', data: { id: mock.lastSentMessageId } },
      { type: 'text', data: { text: '这条是引用你的' } },
    ],
  });
  await waitFor('reply-to-bot triggers', () => sendCount() > c2);

  // 9. 私聊：管理员放行，非管理员忽略
  const c3 = sendCount();
  mock.inject({ message_id: 9040, user_id: ADMIN_QQ, message: [{ type: 'text', data: { text: '私聊测试' } }] });
  await waitFor('private admin reply', () => mock.actionsSince(0, 'send_private_msg').length >= 1);
  const beforeStranger = mock.actionsSince(0, 'send_private_msg').length;
  mock.inject({ message_id: 9041, user_id: 777777, message: [{ type: 'text', data: { text: '陌生人私聊' } }] });
  await sleep(300);
  check('管理员私聊回复 / 陌生人私聊忽略', c3 >= 0 && mock.actionsSince(0, 'send_private_msg').length === beforeStranger);

  // 10. 上下文：总结前包含今日消息
  injectGroup(9050, 501, 'OLDMSG-应被压缩');
  await sleep(200);
  const fakeEvt = {
    post_type: 'message' as const,
    message_type: 'group' as const,
    self_id: BOT_QQ,
    message_id: 999999,
    user_id: 501,
    group_id: GROUP,
    message: [{ type: 'text' as const, data: { text: '新消息' } }],
    raw_message: '新消息',
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 501, nickname: 'u501' },
  };
  const deps = {
    store: app.store,
    memory: app.memory,
    persona: '测试人设',
    botQQ: BOT_QQ,
    botName: 'Tamaki',
    timeZone: 'Asia/Shanghai',
  };
  const before = buildContextMessages(fakeEvt, deps);
  check(
    '总结前上下文包含当天消息（且仅 system+user 两条）',
    before.messages.length === 2 && before.system.includes('OLDMSG-应被压缩'),
  );

  // 10.5 逻辑日界：凌晨 1~2 点不因跨零点失忆
  const TZ = 'Asia/Shanghai';
  check(
    '01:30 时逻辑日界回退到前一天 03:00',
    new Date(startOfLogicalDay(Date.UTC(2026, 0, 1, 17, 30), 3, TZ)).toISOString() === '2025-12-31T19:00:00.000Z',
    new Date(startOfLogicalDay(Date.UTC(2026, 0, 1, 17, 30), 3, TZ)).toISOString(),
  );
  check(
    '10:00 时逻辑日界是当天 03:00',
    new Date(startOfLogicalDay(Date.UTC(2026, 0, 2, 2, 0), 3, TZ)).toISOString() === '2026-01-01T19:00:00.000Z',
  );

  const db2 = openDb(':memory:');
  const ms2 = new MessageStore(db2, TZ, 3);
  const insertAt = (id: number, createdAt: number, text: string) =>
    db2
      .prepare(
        `INSERT INTO messages
         (message_id, self_id, post_type, message_type, group_id, user_id, nickname,
          is_self, raw_message, segments, created_at)
         VALUES (?, 10000, 'message', 'group', 1, 501, 'u501', 0, ?, ?, ?)`,
      )
      .run(id, text, JSON.stringify([{ type: 'text', data: { text } }]), createdAt);

  // 1/1 23:50、1/2 00:30、1/2 02:30（本地时间）
  insertAt(1, Date.UTC(2026, 0, 1, 15, 50), '昨天睡前');
  insertAt(2, Date.UTC(2026, 0, 1, 16, 30), '零点后');
  insertAt(3, Date.UTC(2026, 0, 1, 18, 30), '凌晨两点');
  ms2.setCursor('group:1', Date.UTC(2025, 11, 31, 19, 0)); // 1/1 03:00
  const earlyMorning = ms2.getContextMessages('group:1', undefined, Date.UTC(2026, 0, 1, 18, 59));
  check(
    '凌晨上下文保留前一天 03:00 之后的全部对话',
    earlyMorning.length === 3 && earlyMorning.some((r) => r.id === 1),
    `ids=${earlyMorning.map((r) => r.id).join(',')}`,
  );

  insertAt(4, Date.UTC(2026, 0, 1, 19, 30), '总结之后');
  ms2.setCursor('group:1', Date.UTC(2026, 0, 1, 19, 0, 30)); // 1/2 03:00:30
  const afterSummary = ms2.getContextMessages('group:1', undefined, Date.UTC(2026, 0, 1, 19, 31));
  check(
    '总结推进 cursor 后旧对话不重放',
    afterSummary.length === 1 && afterSummary[0]!.id === 4,
    `ids=${afterSummary.map((r) => r.id).join(',')}`,
  );
  db2.close();

  // 11. 总结 -> MD + memories + cursor 推进
  const summarized = await app.summarizer.summarizeScope(`group:${GROUP}`);
  const memoryFile = join(dataDir, 'memory', 'group_111.md');
  const cursor = app.store.getCursor(`group:${GROUP}`);
  check(
    '总结写 MD / memories / 推进 cursor',
    summarized &&
      existsSync(memoryFile) &&
      readFileSync(memoryFile, 'utf8').includes('群友喜欢猫') &&
      app.memory.memoryVersions(`group:${GROUP}`) >= 1 &&
      cursor > 0,
    `summarized=${summarized} cursor=${cursor}`,
  );

  // 12. 已总结内容不再重放，只保留 cursor 之后的消息
  injectGroup(9051, 501, 'NEWMSG-总结之后');
  await sleep(200);
  const after = buildContextMessages(fakeEvt, deps);
  check(
    '已总结对话不重放，只含记忆 + cursor 后消息',
    after.system.includes('群友喜欢猫') &&
      after.system.includes('NEWMSG-总结之后') &&
      !after.system.includes('OLDMSG-应被压缩'),
  );

  // 13. update_impression 工具
  let toolTurn = 0;
  const impressionLLM: LLMCall = async (messages) => {
    if (toolTurn++ === 0) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'update_impression',
              arguments: JSON.stringify({ user_id: 777, nickname: '阿猫', content: '喜欢猫，话少，常用短句。' }),
            },
          },
        ],
      };
    }
    const toolMsg = [...messages].reverse().find((m) => m.role === 'tool');
    return { role: 'assistant', content: `tool=${toolMsg?.content ?? ''}` };
  };

  const ctx = {
    evt: fakeEvt,
    isAdmin: false,
    scope: scopeOf(fakeEvt as any),
    store: app.store,
    memory: app.memory,
    botQQ: BOT_QQ,
    botName: 'Tamaki',
  };
  const toolAnswer = await runWithTools([{ role: 'user', content: '记住阿猫' }], ctx as any, impressionLLM);
  const impressionFile = join(dataDir, 'impressions', 'group_111.md');
  check(
    'update_impression 写入印象 MD',
    toolAnswer.includes('"ok":true') &&
      existsSync(impressionFile) &&
      readFileSync(impressionFile, 'utf8').includes('喜欢猫，话少'),
  );

  // 14. adminOnly 对非管理员不可见、执行被拒
  registerTool({
    name: 'admin_secret',
    description: 'test',
    parameters: { type: 'object', properties: {} },
    adminOnly: true,
    execute: async () => ({ secret: 1 }),
  });
  check('adminOnly 工具对非管理员不可见', !listToolSchemas(false).some((s) => s.function.name === 'admin_secret'));
  let sawDenied = false;
  let deniedTurn = 0;
  const deniedLLM: LLMCall = async (messages) => {
    if (deniedTurn++ === 0) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c2', type: 'function', function: { name: 'admin_secret', arguments: '{}' } }],
      };
    }
    sawDenied = messages.some((m) => m.role === 'tool' && (m.content ?? '').includes('permission denied'));
    return { role: 'assistant', content: 'done' };
  };
  await runWithTools([{ role: 'user', content: 'x' }], ctx as any, deniedLLM);
  check('adminOnly 执行二次校验拦截', sawDenied);

  // 15. 断线 3s 自动重连
  const connBefore = mock.connectionCount;
  mock.killConnections();
  await waitFor('reconnect', () => mock.connectionCount > connBefore, 9000);
  await waitFor('ws open after reconnect', () => app.client.isOpen, 3000);
  const c4 = sendCount();
  injectGroup(9060, 608, '重连后', [atBot]);
  await waitFor('reply after reconnect', () => sendCount() > c4);
  check('断线后自动重连且可继续收发', true);

  // 16. 90s 心跳机制（测试环境缩短到 1.5s）
  const connBeforeHb = mock.connectionCount;
  mock.stopHeartbeat();
  await waitFor('heartbeat timeout reconnect', () => mock.connectionCount > connBeforeHb, 9000);
  check('心跳超时触发强制重连', mock.connectionCount > connBeforeHb);

  const dbCount = rows().length;
  check('消息全部实时入库', dbCount > 10, `rows=${dbCount}`);
} catch (err) {
  failed++;
  console.error('✗ E2E crashed:', err);
} finally {
  app.stop();
  await mock.stop();
  await sleep(200);
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failed === 0 ? '\n全部自测通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
