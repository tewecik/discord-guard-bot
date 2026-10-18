import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { defaults, settingsSchema, type Settings } from './config.ts';

export type Job = { id: string; kind: string; payload: string; attempts: number; priority: number };
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS signals (id TEXT PRIMARY KEY, actor TEXT NOT NULL, scope TEXT NOT NULL, weight INTEGER NOT NULL, time INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS signal_actor_time ON signals(actor,time);
      CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, time INTEGER NOT NULL, type TEXT NOT NULL, actor TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS incident_time ON incidents(time);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, dedupe TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL, available INTEGER NOT NULL, error TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS trust (subject TEXT NOT NULL, scope TEXT NOT NULL, target TEXT NOT NULL, expires INTEGER NOT NULL, granted_by TEXT NOT NULL, PRIMARY KEY(subject,scope,target));
      CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, time INTEGER NOT NULL, file TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS restore_map (backup TEXT NOT NULL, old TEXT NOT NULL, new TEXT NOT NULL, PRIMARY KEY(backup,old));
    `);
    this.db.exec("UPDATE jobs SET status='pending' WHERE status='running'");
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  set(key: string, value: unknown) { this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  delete(key: string) { this.db.prepare('DELETE FROM kv WHERE key=?').run(key); }
  settings(): Settings { return settingsSchema.parse(this.get('settings') ?? structuredClone(defaults)); }
  saveSettings(value: unknown) { this.set('settings', settingsSchema.parse(value)); }
  once(id: string, now = Date.now()): boolean { return this.db.prepare('INSERT OR IGNORE INTO seen VALUES (?,?)').run(id, now).changes === 1; }
  signal(id: string, actor: string, scope: string, weight: number, time: number, since: number) {
    this.db.prepare('INSERT OR IGNORE INTO signals VALUES (?,?,?,?,?)').run(id, actor, scope, weight, time);
    return this.db.prepare('SELECT scope,COUNT(*) AS count,SUM(weight) AS score FROM signals WHERE actor=? AND time>=? GROUP BY scope').all(actor, since) as { scope: string; count: number; score: number }[];
  }
  incident(type: string, actor: string | null, data: unknown): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO incidents VALUES (?,?,?,?,?)').run(id, Date.now(), type, actor, JSON.stringify(data));
    return id;
  }
  incidents(limit = 10) { return this.db.prepare('SELECT * FROM incidents ORDER BY time DESC LIMIT ?').all(limit); }
  incidentById(id: string) { return this.db.prepare('SELECT * FROM incidents WHERE id=?').get(id); }
  enqueue(kind: string, payload: unknown, dedupe: string, priority = 10) {
    this.db.prepare("INSERT OR IGNORE INTO jobs VALUES (?,?,?,?, 'pending',0,?,?,NULL,?)").run(randomUUID(), dedupe, kind, JSON.stringify(payload), priority, Date.now(), Date.now());
  }
  take(urgent = false): Job | undefined {
    return this.db.prepare(`UPDATE jobs SET status='running', attempts=attempts+1 WHERE id=(SELECT id FROM jobs WHERE status='pending' AND available<=? AND priority ${urgent ? '<' : '>='} 10 ORDER BY priority ASC,created ASC LIMIT 1) RETURNING id,kind,payload,attempts,priority`).get(Date.now()) as Job | undefined;
  }
  finish(id: string) { this.db.prepare("UPDATE jobs SET status='done',error=NULL WHERE id=?").run(id); }
  fail(job: Job, error: string, retry: boolean) { this.db.prepare('UPDATE jobs SET status=?,error=?,available=? WHERE id=?').run(retry && job.attempts < 4 ? 'pending' : 'failed', error.slice(0, 500), Date.now() + Math.min(60_000, 2000 * 2 ** job.attempts), job.id); }
  counts() { return this.db.prepare('SELECT status,COUNT(*) AS count FROM jobs GROUP BY status').all(); }
  trusted(subjects: string[], scope: string, targets: string[], now = Date.now()) {
    return subjects.some(subject => Boolean(this.db.prepare("SELECT 1 FROM trust WHERE subject=? AND (scope=? OR scope='*') AND (target='*' OR target IN (SELECT value FROM json_each(?))) AND expires>? LIMIT 1").get(subject, scope, JSON.stringify(targets), now)));
  }
  grant(subject: string, scope: string, target: string, expires: number, by: string) { this.db.prepare('INSERT INTO trust VALUES (?,?,?,?,?) ON CONFLICT(subject,scope,target) DO UPDATE SET expires=excluded.expires,granted_by=excluded.granted_by').run(subject, scope, target, expires, by); }
  revoke(subject: string) { this.db.prepare('DELETE FROM trust WHERE subject=?').run(subject); }
  trusts() { return this.db.prepare('SELECT * FROM trust WHERE expires>?').all(Date.now()); }
  prune(retentionDays: number) {
    const cutoff = Date.now() - retentionDays * 86400_000;
    this.db.prepare('DELETE FROM signals WHERE time<?').run(Date.now() - 600_000);
    this.db.prepare('DELETE FROM seen WHERE time<?').run(Date.now() - 86400_000);
    this.db.prepare('DELETE FROM incidents WHERE time<?').run(cutoff);
    this.db.prepare("DELETE FROM jobs WHERE status IN ('done','failed') AND created<?").run(cutoff);
    this.db.prepare('DELETE FROM trust WHERE expires<?').run(Date.now());
  }
  close() { this.db.close(); }
}
