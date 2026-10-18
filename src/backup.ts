import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChannelType, AuditLogEvent, DiscordAPIError, type GuildBasedChannel, type GuildChannelCreateOptions } from 'discord.js';
import { z } from 'zod';
import { report, type Context } from './context.ts';

const id = z.string().regex(/^\d{17,22}$/);
const bits = z.string().regex(/^\d+$/);
const roleSchema = z.object({ id, name: z.string().max(100), color: z.number().int(), hoist: z.boolean(), mentionable: z.boolean(), permissions: bits, position: z.number().int(), managed: z.boolean() });
const channelSchema = z.object({ id, type: z.number().int(), name: z.string().max(100), position: z.number().int(), parentId: id.nullable(), topic: z.string().nullable(), nsfw: z.boolean(), rateLimitPerUser: z.number().int(), bitrate: z.number().int().optional(), userLimit: z.number().int().optional(), permissionOverwrites: z.array(z.object({ id, type: z.union([z.literal(0), z.literal(1)]), allow: bits, deny: bits })).max(1000) });
const snapshotSchema = z.object({ version: z.literal(1), guildId: id, time: z.number(), roles: z.array(roleSchema).max(1000), channels: z.array(channelSchema).max(2000), settings: z.object({ name: z.string(), verificationLevel: z.number().int(), explicitContentFilter: z.number().int(), defaultMessageNotifications: z.number().int() }) });
export type Snapshot = z.infer<typeof snapshotSchema>;
export function seal(value: unknown, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('VIIBE-GUARD:1'));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('VGB1'), iv, cipher.getAuthTag(), body]);
}
export function unseal(data: Buffer, key: Buffer): unknown {
  if (data.length < 33 || data.subarray(0, 4).toString() !== 'VGB1') throw new Error('Geçersiz yedek biçimi.');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(4, 16));
  decipher.setAAD(Buffer.from('VIIBE-GUARD:1'));
  decipher.setAuthTag(data.subarray(16, 32));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]).toString('utf8'));
}
function channelData(channel: GuildBasedChannel): z.infer<typeof channelSchema> | undefined {
  if (!('permissionOverwrites' in channel)) return;
  return {
    id: channel.id, name: channel.name, type: channel.type, position: channel.rawPosition, parentId: channel.parentId,
    topic: 'topic' in channel ? channel.topic : null, nsfw: 'nsfw' in channel ? channel.nsfw : false,
    rateLimitPerUser: 'rateLimitPerUser' in channel ? channel.rateLimitPerUser ?? 0 : 0,
    ...('bitrate' in channel ? { bitrate: channel.bitrate, userLimit: channel.userLimit } : {}),
    permissionOverwrites: [...channel.permissionOverwrites.cache.values()].map(o => ({ id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() }))
  };
}
export async function capture(ctx: Context): Promise<Snapshot> {
  const [roles, channels] = await Promise.all([ctx.guild.roles.fetch(), ctx.guild.channels.fetch()]);
  await ctx.guild.fetch();
  return snapshotSchema.parse({ version: 1, guildId: ctx.guild.id, time: Date.now(),
    roles: [...roles.values()].map(r => ({ id: r.id, name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions.bitfield.toString(), position: r.position, managed: r.managed })),
    channels: [...channels.values()].filter(c => c !== null).map(channelData).filter(Boolean),
    settings: { name: ctx.guild.name, verificationLevel: ctx.guild.verificationLevel, explicitContentFilter: ctx.guild.explicitContentFilter, defaultMessageNotifications: ctx.guild.defaultMessageNotifications }
  });
}
export async function backup(ctx: Context) {
  const snapshot = await capture(ctx);
  const backupId = randomUUID();
  const dir = join(ctx.env.dataDir, 'backups');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = `${backupId}.vgb`;
  const data = seal(snapshot, ctx.env.key);
  await writeFile(join(dir, `${file}.tmp`), data, { mode: 0o600 });
  await rename(join(dir, `${file}.tmp`), join(dir, file));
  const hash = createHash('sha256').update(data).digest('hex');
  ctx.store.db.prepare('INSERT INTO backups VALUES (?,?,?,?)').run(backupId, snapshot.time, file, hash);
  const excess = ctx.store.db.prepare('SELECT id,file FROM backups ORDER BY time DESC LIMIT -1 OFFSET ?').all(ctx.store.settings().backupRetention) as { id: string; file: string }[];
  for (const row of excess) {
    if (ctx.store.get<string>('restore:active') === row.id) continue;
    await unlink(join(dir, row.file)).catch(() => {});
    ctx.store.db.prepare('DELETE FROM backups WHERE id=?').run(row.id);
  }
  ctx.store.set('lastBackup', snapshot.time);
  await report(ctx, 'backup_created', null, { id: backupId, roles: snapshot.roles.length, channels: snapshot.channels.length, hash });
  return backupId;
}
export async function loadBackup(ctx: Context, backupId: string): Promise<Snapshot> {
  z.uuid().parse(backupId);
  const row = ctx.store.db.prepare('SELECT file,hash FROM backups WHERE id=?').get(backupId) as { file: string; hash: string } | undefined;
  if (!row || row.file !== `${backupId}.vgb`) throw new Error('Yedek bulunamadı.');
  const encrypted = await readFile(join(ctx.env.dataDir, 'backups', row.file));
  if (createHash('sha256').update(encrypted).digest('hex') !== row.hash) throw new Error('Yedek özeti uyuşmuyor.');
  const snapshot = snapshotSchema.parse(unseal(encrypted, ctx.env.key));
  if (snapshot.guildId !== ctx.guild.id) throw new Error('Yedek başka bir sunucuya ait.');
  return snapshot;
}
export function backupList(ctx: Context) { return ctx.store.db.prepare('SELECT id,time FROM backups ORDER BY time DESC LIMIT 25').all(); }
function mapped(ctx: Context, backupId: string, old: string) {
  const row = ctx.store.db.prepare('SELECT new FROM restore_map WHERE backup=? AND old=?').get(backupId, old) as { new: string } | undefined;
  return row?.new ?? old;
}
function saveMap(ctx: Context, backupId: string, old: string, current: string) { ctx.store.db.prepare('INSERT INTO restore_map VALUES (?,?,?) ON CONFLICT(backup,old) DO UPDATE SET new=excluded.new').run(backupId, old, current); }
export async function restorePreview(ctx: Context, backupId: string) {
  const snapshot = await loadBackup(ctx, backupId);
  await Promise.all([ctx.guild.roles.fetch(), ctx.guild.channels.fetch()]);
  return { backupId, time: snapshot.time, missingRoles: snapshot.roles.filter(r => !r.managed && !ctx.guild.roles.cache.has(mapped(ctx, backupId, r.id))).map(r => r.name), missingChannels: snapshot.channels.filter(c => !ctx.guild.channels.cache.has(mapped(ctx, backupId, c.id))).map(c => c.name), note: 'Var olan roller/kanallar da yedek değerlerine döner. Üyelikler, mesajlar ve yönetilen roller geri yüklenmez. Fazladan varlıklar silinmez.' };
}
async function recoverCreated(ctx: Context, journal: string, type: AuditLogEvent): Promise<string | undefined> {
  if (!ctx.store.get(journal)) return;
  const logs = await ctx.guild.fetchAuditLogs({ type, limit: 100 });
  const found = logs.entries.find(e => e.executorId === ctx.client.user?.id && e.reason === journal);
  if (found?.targetId) return found.targetId;
  throw new Error(`Yarım kalan oluşturma doğrulanamadı: ${journal}. Yinelenen varlık oluşturmamak için durduruldu.`);
}
export async function restore(ctx: Context, backupId: string, part: 'roles' | 'channels' | 'all', runId: string = randomUUID()) {
  const snapshot = await loadBackup(ctx, backupId);
  const active = ctx.store.get<string>('restore:active');
  if (active && active !== backupId) throw new Error('Başka bir recovery işlemi etkin.');
  ctx.store.set('restore:active', backupId);
  const skipped: string[] = [];
  try {
    await Promise.all([ctx.guild.roles.fetch(), ctx.guild.channels.fetch()]);
    const me = await ctx.guild.members.fetchMe();
    if (part === 'roles' || part === 'all' || part === 'channels') {
      for (const source of snapshot.roles.toSorted((a, b) => a.position - b.position)) {
        if (source.managed) continue;
        const checkpoint = `restored:${runId}:role:${source.id}`;
        if (ctx.store.get(checkpoint)) continue;
        let role = ctx.guild.roles.cache.get(mapped(ctx, backupId, source.id));
        if (part === 'channels' && role) continue;
        const journal = `Guard recovery ${runId} role ${source.id}`;
        const recovered = !role ? await recoverCreated(ctx, journal, AuditLogEvent.RoleCreate) : undefined;
        if (recovered) { role = await ctx.guild.roles.fetch(recovered) ?? undefined; saveMap(ctx, backupId, source.id, recovered); }
        const options = { name: source.name, color: source.color, hoist: source.hoist, mentionable: source.mentionable, permissions: BigInt(source.permissions), reason: journal };
        if (!role) {
          ctx.store.set(journal, true);
          role = await ctx.guild.roles.create(options);
          saveMap(ctx, backupId, source.id, role.id);
        } else {
          if (role.id !== ctx.guild.id && (!role.editable || role.comparePositionTo(me.roles.highest) >= 0)) { skipped.push(`role:${source.id}:hierarchy`); continue; }
          await role.edit(role.id === ctx.guild.id ? { permissions: options.permissions, reason: journal } : options);
        }
        if (role.id !== ctx.guild.id) await role.setPosition(Math.min(source.position, me.roles.highest.position - 1), { reason: journal });
        ctx.store.set(checkpoint, true);
      }
    }
    if (part === 'channels' || part === 'all') {
      const sorted = snapshot.channels.toSorted((a, b) => Number(b.type === ChannelType.GuildCategory) - Number(a.type === ChannelType.GuildCategory) || a.position - b.position);
      for (const source of sorted) {
        const checkpoint = `restored:${runId}:channel:${source.id}`;
        if (ctx.store.get(checkpoint)) continue;
        const journal = `Guard recovery ${runId} channel ${source.id}`;
        let channel = ctx.guild.channels.cache.get(mapped(ctx, backupId, source.id));
        const recovered = !channel ? await recoverCreated(ctx, journal, AuditLogEvent.ChannelCreate) : undefined;
        if (recovered) { channel = await ctx.guild.channels.fetch(recovered) ?? undefined; saveMap(ctx, backupId, source.id, recovered); }
        const overwrites = [];
        for (const o of source.permissionOverwrites) {
          const overwriteId = o.type === 0 ? mapped(ctx, backupId, o.id) : o.id;
          if (o.type === 0 && !ctx.guild.roles.cache.has(overwriteId)) throw new Error(`İzin rolü eksik: ${o.id}`);
          if (o.type === 1) {
            try { await ctx.guild.members.fetch(overwriteId); }
            catch (error) {
              if (error instanceof DiscordAPIError && error.code === 10007) { skipped.push(`overwrite:${overwriteId}:member_absent`); continue; }
              throw error;
            }
          }
          overwrites.push({ id: overwriteId, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) });
        }
        const parent = source.parentId ? mapped(ctx, backupId, source.parentId) : null;
        if (parent && !ctx.guild.channels.cache.has(parent)) throw new Error(`Üst kategori eksik: ${parent}`);
        const options = { name: source.name, type: source.type, parent, position: source.position, topic: source.topic, nsfw: source.nsfw, rateLimitPerUser: source.rateLimitPerUser, permissionOverwrites: overwrites, ...(source.bitrate !== undefined ? { bitrate: Math.min(source.bitrate, ctx.guild.maximumBitrate), userLimit: source.userLimit } : {}), reason: journal };
        if (!channel) {
          ctx.store.set(journal, true);
          channel = await ctx.guild.channels.create(options as GuildChannelCreateOptions);
          saveMap(ctx, backupId, source.id, channel.id);
        } else if ('permissionOverwrites' in channel) {
          if (channel.type !== source.type) throw new Error(`Kanal tipi değişmiş: ${source.id}`);
          const { type: _, ...edit } = options;
          await channel.edit(edit);
        }
        ctx.store.set(checkpoint, true);
      }
    }
    if (part === 'all' && !ctx.store.get(`restored:${runId}:settings`)) {
      await ctx.guild.edit({ ...snapshot.settings, reason: `Guard recovery ${backupId}` });
      ctx.store.set(`restored:${runId}:settings`, true);
    }
    await report(ctx, skipped.length ? 'recovery_partial' : 'recovery_complete', null, { backupId, runId, part, skipped });
  } finally { ctx.store.delete('restore:active'); }
}
