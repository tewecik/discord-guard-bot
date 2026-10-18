import { mkdirSync, existsSync, readFileSync, readdirSync, unlinkSync, openSync, writeFileSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Client, Events, GatewayIntentBits, Options } from 'discord.js';
import { environment } from './config.ts';
import { Store } from './store.ts';
import { Logger } from './logger.ts';
import { Engine } from './engine.ts';
import { Worker } from './worker.ts';
import { handleInteraction } from './commands.ts';
import { type Context, report } from './context.ts';

const env = environment();
mkdirSync(env.dataDir, { recursive: true, mode: 0o700 });
const logDir = join(env.dataDir, 'logs');
mkdirSync(logDir, { recursive: true, mode: 0o700 });
const log = new Logger(logDir, [env.token, env.key.toString('base64')]);
const lockPath = join(env.dataDir, 'process.lock');
if (existsSync(lockPath)) {
  const pid = Number(readFileSync(lockPath, 'utf8'));
  let running = true;
  try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') running = false; }
  if (running) throw new Error('Aynı veri dizinini kullanan bot zaten çalışıyor.');
  unlinkSync(lockPath);
}
const lockFd = openSync(lockPath, 'wx', 0o600);
writeFileSync(lockFd, String(process.pid));
closeSync(lockFd);
const store = new Store(join(env.dataDir, 'guard.sqlite'));
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildWebhooks];
if (env.messageContent) intents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents, allowedMentions: { parse: [] }, makeCache: Options.cacheWithLimits({ MessageManager: 100 }), rest: { timeout: 15_000, retries: 2 } });
let ctx: Context | undefined;
let engine: Engine | undefined;
let worker: Worker | undefined;
let maintenance: NodeJS.Timeout | undefined;
let stopping = false;
const health = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/healthz') { res.writeHead(404).end(); return; }
  const ready = client.isReady() && !!ctx && !stopping;
  res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ready, uptime: Math.floor(process.uptime()) }));
});
health.listen(env.healthPort, '127.0.0.1');
const safe = (event: string, work: () => Promise<unknown>) => { void work().catch(e => { log.error(event, e); if (event === 'ready') void shutdown(1); }); };
let syncing = false;
async function reconcile() {
  if (!ctx || !engine || syncing) return;
  syncing = true;
  try {
    const audit = await ctx.guild.fetchAuditLogs({ limit: 100 });
    const recent = [...audit.entries.values()].filter(e => Date.now() - e.createdTimestamp < 60_000).toSorted((a, b) => a.createdTimestamp - b.createdTimestamp);
    if (recent.length === 100) await report(ctx, 'audit_replay_limit', null, { message: 'Son 100 kayıt tarandı; daha eski olaylarda boşluk olabilir.' });
    for (const entry of recent) await engine.audit(entry);
  } finally { syncing = false; }
}
client.once(Events.ClientReady, () => safe('ready', async () => {
  const guild = await client.guilds.fetch(env.guildId);
  await Promise.all([guild.roles.fetch(), guild.channels.fetch(), guild.members.fetchMe()]);
  ctx = { client, guild, env, store, log };
  engine = new Engine(ctx);
  worker = new Worker(ctx);
  worker.start();
  await report(ctx, 'started', null, { mode: store.settings().mode, node: process.version });
  await reconcile();
  const tick = () => {
    const settings = store.settings();
    if (Date.now() - (store.get<number>('lastBackup') ?? 0) > settings.backupIntervalMinutes * 60000 && !store.get('restore:active')) {
      const pending = store.db.prepare("SELECT 1 FROM jobs WHERE kind='backup' AND status IN ('pending','running')").get();
      if (!pending) store.enqueue('backup', {}, `scheduled:${Math.floor(Date.now() / 60000)}`, 20);
    }
    store.prune(settings.retentionDays);
    store.db.prepare("DELETE FROM kv WHERE key LIKE 'confirm:%' AND json_extract(value,'$.expires')<?").run(Date.now());
    engine?.sweep();
    for (const name of readdirSync(logDir)) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && Date.parse(name.slice(0, 10)) < Date.now() - settings.retentionDays * 86400_000) unlinkSync(join(logDir, name));
    }
  };
  tick(); maintenance = setInterval(() => { try { tick(); } catch (error) { log.error('maintenance', error); } }, 60_000);
}));
client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => { if (guild.id === env.guildId && engine) safe('audit', () => engine!.audit(entry)); });
client.on(Events.GuildMemberAdd, member => { if (member.guild.id === env.guildId && engine) safe('join', () => engine!.join(member)); });
client.on(Events.MessageCreate, message => { if (engine) safe('message', () => engine!.message(message)); });
client.on(Events.InteractionCreate, interaction => { if (ctx) safe('interaction', () => handleInteraction(ctx!, interaction)); });
client.on(Events.Error, error => log.error('discord', error));
client.on(Events.ShardDisconnect, event => log.write('warn', 'gateway_disconnected', { code: event.code }));
client.on(Events.ShardResume, () => { log.write('info', 'gateway_resumed'); safe('reconcile', reconcile); });
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (maintenance) clearInterval(maintenance);
  health.close();
  const deadline = setTimeout(() => process.exit(1), 20_000).unref();
  await worker?.stop();
  await client.destroy();
  store.close();
  unlinkSync(lockPath);
  clearTimeout(deadline);
  process.exit(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('unhandledRejection', e => { log.error('unhandled_rejection', e); void shutdown(1); });
process.on('uncaughtException', e => { log.error('uncaught_exception', e); void shutdown(1); });
health.on('error', e => { log.error('health', e); void shutdown(1); });
try { await client.login(env.token); } catch (e) { log.error('login_failed', e); await shutdown(1); }
