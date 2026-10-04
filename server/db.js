// 数据库连接与表结构（SQLite，文件持久化）
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(path.join(DATA_DIR, 'neonatal.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('nurse','family','doctor')),
  name TEXT NOT NULL,
  title TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_user_id INTEGER REFERENCES users(id),
  mother_name TEXT NOT NULL,
  baby_name TEXT NOT NULL,
  baby_gender TEXT DEFAULT '女',
  birth_date TEXT NOT NULL,            -- 出生日期时间 ISO
  birth_weight REAL NOT NULL,          -- 出生体重 g
  delivery_mode TEXT NOT NULL,         -- 顺产/剖宫产/产钳助产
  feeding_type TEXT NOT NULL,          -- 母乳喂养/配方奶喂养/混合喂养
  jaundice_risk TEXT DEFAULT '低',     -- 黄疸风险 低/中/高
  maternal_wound TEXT DEFAULT '愈合良好', -- 产妇伤口
  address TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  discharge_date TEXT,                 -- 出院日期
  care_ability TEXT DEFAULT '良好',    -- 家庭照护能力 良好/一般/薄弱
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives(id),
  nurse_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL DEFAULT '初访',    -- 初访/复查/加访
  scheduled_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '待访视', -- 待访视/已完成/已改约/未开门/已取消
  reason TEXT DEFAULT '',              -- 改约/未开门等原因
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT UNIQUE,               -- 离线草稿幂等键
  appointment_id INTEGER REFERENCES appointments(id),
  archive_id INTEGER NOT NULL REFERENCES archives(id),
  nurse_id INTEGER REFERENCES users(id),
  visit_time TEXT NOT NULL,
  weight REAL,                         -- 婴儿体重 g
  bilirubin REAL,                      -- 经皮黄疸值 µmol/L
  bilirubin_site TEXT DEFAULT '额头',
  cord TEXT DEFAULT '干燥',            -- 脐带情况
  stool_count INTEGER DEFAULT 0,
  stool_color TEXT DEFAULT '黄色',
  urine_count INTEGER DEFAULT 0,
  feeding_type TEXT DEFAULT '',
  feeding_freq INTEGER DEFAULT 0,      -- 喂养频次 次/日
  spit_up TEXT DEFAULT '无',           -- 吐奶
  sleep TEXT DEFAULT '正常',           -- 睡眠
  breast TEXT DEFAULT '正常',          -- 产妇乳房
  mood TEXT DEFAULT '平稳',            -- 产妇情绪
  wound_check TEXT DEFAULT '愈合良好', -- 产妇伤口复查
  care_ability TEXT DEFAULT '良好',    -- 家庭照护能力（现场评估）
  device_issue INTEGER DEFAULT 0,      -- 社区设备故障，手工记录
  photos TEXT DEFAULT '[]',            -- JSON [dataUrl]
  advice TEXT DEFAULT '',              -- 护理建议（家属可见）
  risk_level TEXT DEFAULT '低',        -- 低/中/高/危急
  flags TEXT DEFAULT '[]',             -- JSON 风险标记
  need_recheck INTEGER DEFAULT 0,
  need_referral INTEGER DEFAULT 0,
  need_lactation INTEGER DEFAULT 0,
  need_phone INTEGER DEFAULT 0,
  device_no TEXT DEFAULT '',          -- 经皮胆红素仪设备编号
  doctor_advice TEXT DEFAULT '',     -- 现场医生/医嘱建议（临界值时必录）
  created_offline INTEGER DEFAULT 0,   -- 是否离线草稿补录
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives(id),
  visit_id INTEGER REFERENCES visits(id),
  type TEXT NOT NULL,                  -- 复查/转诊/母乳指导/电话随访/线上咨询/再次预约
  title TEXT NOT NULL,
  detail TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT '待处理', -- 待处理/进行中/已闭环
  due_date TEXT,
  created_by TEXT DEFAULT '系统',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  closed_at TEXT,
  closed_by TEXT,
  close_note TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives(id),
  uploader_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL,                  -- 出生证明/出院小结/喂养记录/其他
  filename TEXT NOT NULL,
  data_url TEXT DEFAULT '',            -- base64（演示环境小文件）
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS consults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives(id),
  user_id INTEGER REFERENCES users(id),
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '待回复', -- 待回复/已回复
  reply TEXT DEFAULT '',
  replied_by TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  replied_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives(id),
  kind TEXT NOT NULL,                  -- 预约/改约/未开门/访视/复查/转诊/指导/材料/咨询/决策/闭环
  title TEXT NOT NULL,
  detail TEXT DEFAULT '',
  actor TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- 黄疸临界值复查任务（家属选择“次日复测”后生成，明确护士+设备；再次改约可升级社区医生）
CREATE TABLE IF NOT EXISTS recheck_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives(id),
  source_visit_id INTEGER NOT NULL REFERENCES visits(id),  -- 触发临界值的前一天访视
  recheck_visit_id INTEGER REFERENCES visits(id),          -- 实际复测访视（完成后回填）
  appointment_id INTEGER REFERENCES appointments(id),
  family_choice TEXT DEFAULT '',        -- 复测/当天就诊/观察
  status TEXT NOT NULL DEFAULT '待选择', -- 待选择/待复测/已就诊/观察中/已升级/已完成/已取消
  assign_nurse_id INTEGER REFERENCES users(id),
  device_no TEXT DEFAULT '',            -- 本次复测携带的设备编号
  remind_prepared INTEGER DEFAULT 0,    -- 复测前是否已提醒家属准备喂养/排便记录
  remind_at TEXT,
  reschedule_count INTEGER DEFAULT 0,   -- 家属再次改约次数（>=1 升级社区医生）
  escalated_at TEXT,
  doctor_decision TEXT DEFAULT '',      -- 电话干预/建议直接就诊/继续观察
  doctor_note TEXT DEFAULT '',
  risk_notice TEXT DEFAULT '',          -- 家属选择观察时的风险告知文本
  due_date TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

-- 转诊单：复测黄疸升高时生成，自动带入前一天记录便于医院判断变化趋势
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives(id),
  recheck_task_id INTEGER REFERENCES recheck_tasks(id),
  previous_visit_id INTEGER REFERENCES visits(id),
  current_visit_id INTEGER REFERENCES visits(id),
  followup_id INTEGER REFERENCES followups(id),
  bilirubin_prev REAL,
  bilirubin_site_prev TEXT DEFAULT '',
  bilirubin_now REAL,
  bilirubin_site_now TEXT DEFAULT '',
  bilirubin_delta REAL,                 -- 24h 升高幅度
  threshold_now REAL,
  age_days_prev INTEGER,
  age_days_now INTEGER,
  weight_prev REAL,
  weight_now REAL,
  feeding_prev TEXT DEFAULT '',
  feeding_now TEXT DEFAULT '',
  trend_note TEXT DEFAULT '',           -- 变化趋势描述
  status TEXT NOT NULL DEFAULT '待就诊', -- 待就诊/已就诊/已取消
  created_by TEXT DEFAULT '系统',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  visited_at TEXT,
  hospital_feedback TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_appt_archive ON appointments(archive_id);
CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_visit_archive ON visits(archive_id);
CREATE INDEX IF NOT EXISTS idx_followup_status ON followups(status);
CREATE INDEX IF NOT EXISTS idx_events_archive ON events(archive_id);
CREATE INDEX IF NOT EXISTS idx_recheck_archive ON recheck_tasks(archive_id);
CREATE INDEX IF NOT EXISTS idx_recheck_status ON recheck_tasks(status);
CREATE INDEX IF NOT EXISTS idx_referral_archive ON referrals(archive_id);
`)

// —— 轻量迁移：兼容旧版数据库（CREATE TABLE IF NOT EXISTS 不会给已存在的表补列） ——
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}
ensureColumn('visits', 'device_no', `TEXT DEFAULT ''`)
ensureColumn('visits', 'doctor_advice', `TEXT DEFAULT ''`)
ensureColumn('appointments', 'recheck_task_id', 'INTEGER REFERENCES recheck_tasks(id)')

export function addEvent(archiveId, kind, title, detail = '', actor = '') {
  db.prepare('INSERT INTO events (archive_id, kind, title, detail, actor) VALUES (?,?,?,?,?)')
    .run(archiveId, kind, title, detail, actor)
}

export default db
