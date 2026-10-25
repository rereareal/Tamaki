import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/** v2：共享消息 + session 归属 + 按角色隔离的记忆/cursor。 */
const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_character ON sessions(character_id, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_open ON sessions(ended_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  self_id INTEGER,
  post_type TEXT NOT NULL,
  message_type TEXT NOT NULL,
  group_id INTEGER,
  user_id INTEGER,
  nickname TEXT,
  is_self INTEGER NOT NULL DEFAULT 0,
  raw_message TEXT,
  segments TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session_time ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_user_time ON messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
CREATE INDEX IF NOT EXISTS idx_messages_self_time ON messages(is_self, created_at);

CREATE VIEW IF NOT EXISTS human_messages AS
  SELECT * FROM messages WHERE is_self = 0;
CREATE VIEW IF NOT EXISTS bot_messages AS
  SELECT * FROM messages WHERE is_self = 1;

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(character_id, scope, version)
);

CREATE TABLE IF NOT EXISTS summary_cursor (
  character_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  last_ts INTEGER NOT NULL,
  PRIMARY KEY (character_id, scope)
);
`;

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 3000;');

  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const version = Number(row?.user_version ?? 0);
  const existingMessages = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get() as { sql?: string } | undefined;
  const oldMessagesSchema = Boolean(existingMessages?.sql && !existingMessages.sql.includes('session_id'));
  if ((version !== 0 && version < SCHEMA_VERSION) || (version === 0 && oldMessagesSchema)) {
    // 预发布阶段的破坏性迁移：旧 messages 没有 session_id，直接重建运行时表。
    db.exec(`
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS memories;
      DROP TABLE IF EXISTS summary_cursor;
    `);
  }

  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  return db;
}
