import { z } from 'zod';
import { resolve } from 'node:path';

export const scopes = ['channels', 'roles', 'members', 'permissions', 'bots', 'webhooks', 'guild', 'assets', 'automod', 'threads'] as const;
export type Scope = typeof scopes[number];
const snowflake = z.string().regex(/^\d{17,22}$/);
const rule = z.object({ enabled: z.boolean(), limit: z.number().int().min(1).max(100), weight: z.number().int().min(1).max(100) }).strict();
export const settingsSchema = z.object({
  mode: z.enum(['observe', 'enforce']),
  logChannelId: snowflake.nullable(),
  windowSeconds: z.number().int().min(5).max(300),
  combinedLimit: z.number().int().min(1).max(1000),
  action: z.enum(['strip', 'ban']),
  rules: z.object(Object.fromEntries(scopes.map(s => [s, rule])) as Record<Scope, typeof rule>).strict(),
  raid: z.object({ enabled: z.boolean(), joins: z.number().int().min(3).max(1000), windowSeconds: z.number().int().min(5).max(300), youngAccountHours: z.number().int().min(1).max(8760), youngRatio: z.number().min(0).max(1), holdMinutes: z.number().int().min(1).max(1440) }).strict(),
  spam: z.object({ enabled: z.boolean(), messages: z.number().int().min(2).max(100), windowSeconds: z.number().int().min(2).max(60), duplicateLimit: z.number().int().min(2).max(100), mentionLimit: z.number().int().min(1).max(100), timeoutMinutes: z.number().int().min(1).max(1440), blockInvites: z.boolean(), blockedDomains: z.array(z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i)).max(500), blockedExtensions: z.array(z.string().regex(/^\.[a-z0-9]{1,10}$/i)).max(100) }).strict(),
  lockdownChannelIds: z.array(snowflake).max(100),
  backupIntervalMinutes: z.number().int().min(5).max(1440),
  backupRetention: z.number().int().min(2).max(1000),
  retentionDays: z.number().int().min(1).max(365)
}).strict();
export type Settings = z.infer<typeof settingsSchema>;
export const defaults: Settings = settingsSchema.parse({
  mode: 'observe', logChannelId: null, windowSeconds: 30, combinedLimit: 8, action: 'strip',
  rules: Object.fromEntries(scopes.map(s => [s, { enabled: true, limit: ['permissions', 'bots', 'guild', 'automod'].includes(s) ? 1 : s === 'threads' ? 8 : 3, weight: ['permissions', 'bots', 'guild', 'automod'].includes(s) ? 8 : 2 }])),
  raid: { enabled: true, joins: 10, windowSeconds: 15, youngAccountHours: 72, youngRatio: 0.6, holdMinutes: 10 },
  spam: { enabled: true, messages: 7, windowSeconds: 6, duplicateLimit: 4, mentionLimit: 6, timeoutMinutes: 10, blockInvites: false, blockedDomains: [], blockedExtensions: ['.exe', '.scr', '.bat', '.cmd', '.ps1', '.vbs'] },
  lockdownChannelIds: [], backupIntervalMinutes: 60, backupRetention: 48, retentionDays: 30
});
export function environment() {
  const parsed = z.object({
    DISCORD_TOKEN: z.string().min(30), APPLICATION_ID: snowflake, GUILD_ID: snowflake,
    OWNER_IDS: z.string().default(''), BACKUP_KEY: z.string(), DATA_DIR: z.string().default('./data'),
    HEALTH_PORT: z.coerce.number().int().min(1024).max(65535).default(3100),
    MESSAGE_CONTENT_ENABLED: z.enum(['true', 'false']).default('false')
  }).parse(process.env);
  const key = Buffer.from(parsed.BACKUP_KEY, 'base64');
  if (key.length !== 32 || key.toString('base64') !== parsed.BACKUP_KEY) throw new Error('BACKUP_KEY: 32 bayt base64 anahtar gerekli.');
  const owners = parsed.OWNER_IDS.split(',').map(s => s.trim()).filter(Boolean);
  owners.forEach(id => snowflake.parse(id));
  return { token: parsed.DISCORD_TOKEN, applicationId: parsed.APPLICATION_ID, guildId: parsed.GUILD_ID, owners, key, dataDir: resolve(parsed.DATA_DIR), healthPort: parsed.HEALTH_PORT, messageContent: parsed.MESSAGE_CONTENT_ENABLED === 'true' };
}
export type Environment = ReturnType<typeof environment>;
