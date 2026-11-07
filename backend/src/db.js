import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  townpass_user_id TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  trust_score INTEGER NOT NULL DEFAULT 0,
  languages TEXT NOT NULL,
  nearby_notifications_enabled INTEGER NOT NULL DEFAULT 1,
  nearby_radius_m INTEGER NOT NULL DEFAULT 1000,
  location_sharing TEXT NOT NULL DEFAULT 'approximate',
  role TEXT NOT NULL DEFAULT 'user',
  banned_at TEXT,
  ban_reason TEXT,
  last_lat REAL,
  last_lng REAL,
  location_updated_at TEXT,
  last_nearby_notified_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open',
  title TEXT NOT NULL,
  title_is_auto INTEGER NOT NULL DEFAULT 0,
  body TEXT,
  category TEXT NOT NULL,
  language TEXT NOT NULL,
  assistance_mode TEXT NOT NULL,
  location_sharing TEXT NOT NULL,
  context TEXT,
  service_id TEXT,
  approx_lat REAL,
  approx_lng REAL,
  exact_lat REAL,
  exact_lng REAL,
  answer_count INTEGER NOT NULL DEFAULT 0,
  accepted_answer_id TEXT,
  client_request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (author_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_questions_created ON questions (created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT,
  language TEXT,
  is_accepted INTEGER NOT NULL DEFAULT 0,
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  client_request_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers (question_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_answers_request ON answers (author_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS votes (
  answer_id TEXT NOT NULL REFERENCES answers(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  value INTEGER NOT NULL,
  PRIMARY KEY (answer_id, user_id)
);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_seconds REAL,
  question_id TEXT,
  answer_id TEXT,
  position INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS question_tags (
  question_id TEXT NOT NULL REFERENCES questions(id),
  tag_key TEXT NOT NULL,
  tag TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (question_id, tag_key)
);
CREATE INDEX IF NOT EXISTS idx_question_tags_key ON question_tags (tag_key);
CREATE TABLE IF NOT EXISTS admin_actions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions (created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS assists (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id),
  asker_id TEXT NOT NULL REFERENCES users(id),
  helper_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  arrived_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assists_active ON assists (question_id) WHERE status IN ('claimed', 'arrived');
CREATE TABLE IF NOT EXISTS pii_reports (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id),
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  media_id TEXT,
  text_field TEXT,
  regions TEXT NOT NULL DEFAULT '[]',
  text_ranges TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  reporter_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pii_target ON pii_reports (target_type, target_id, status);
CREATE INDEX IF NOT EXISTS idx_pii_question ON pii_reports (question_id, status);
CREATE TABLE IF NOT EXISTS user_badges (
  user_id TEXT NOT NULL REFERENCES users(id),
  badge_id TEXT NOT NULL,
  earned_at TEXT NOT NULL,
  PRIMARY KEY (user_id, badge_id)
);
DROP TABLE IF EXISTS devices;
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS point_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  question_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  question_id TEXT,
  exact_lat REAL,
  exact_lng REAL,
  read INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS push_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_nearby_once ON notifications (user_id, question_id)
  WHERE type = 'nearby_question';
`;

export function openDatabase(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'media'), { recursive: true });
  const db = new Database(path.join(dataDir, 'app.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // CREATE TABLE IF NOT EXISTS 不會替既有資料表加欄位，已上線的資料庫要另外補。
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!userColumns.has('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  if (!userColumns.has('banned_at')) db.exec('ALTER TABLE users ADD COLUMN banned_at TEXT');
  if (!userColumns.has('ban_reason')) db.exec('ALTER TABLE users ADD COLUMN ban_reason TEXT');
  return db;
}
