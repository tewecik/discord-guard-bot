import { createHash } from 'node:crypto';
import { AuditLogEvent, type GuildAuditLogsEntry, type GuildMember, type Message } from 'discord.js';
import { classify, dangerous, decide, domainBlocked } from './policy.ts';
import { isController, report, type Context } from './context.ts';

type MessageSignal = { time: number; hash: string };
export class Engine {
  private messages = new Map<string, MessageSignal[]>();
  private joins: { id: string; time: number; young: boolean }[] = [];
  constructor(private ctx: Context) {}
  private cooldown(key: string, seconds: number) {
    const previous = this.ctx.store.get<number>(`cooldown:${key}`) ?? 0;
    if (previous > Date.now()) return false;
    this.ctx.store.set(`cooldown:${key}`, Date.now() + seconds * 1000);
    return true;
  }
  async audit(entry: GuildAuditLogsEntry) {
    const ctx = this.ctx;
    if (!ctx.store.once(`audit:${entry.id}`)) return;
    if (Date.now() - entry.createdTimestamp > 60_000 || entry.createdTimestamp > Date.now() + 5000) {
      await report(ctx, 'stale_audit', entry.executorId, { auditId: entry.id, action: entry.action, target: entry.targetId });
      return;
    }
    const actor = entry.executorId;
    if (actor === ctx.client.user?.id) return;
    const member = actor ? await ctx.guild.members.fetch(actor).catch(() => null) : null;
    const added = entry.changes.find(c => c.key === '$add')?.new as { id: string }[] | undefined;
    const dangerousAdded = added?.some(r => ((ctx.guild.roles.cache.get(r.id)?.permissions.bitfield ?? 0n) & dangerous) !== 0n) ?? false;
    const scope = classify(entry.action, entry.changes, dangerousAdded);
    const settings = ctx.store.settings();
    if (!scope || !settings.rules[scope].enabled) return;
    const channel = entry.targetId ? ctx.guild.channels.cache.get(entry.targetId) : undefined;
    const targets = [entry.targetId, channel?.parentId].filter((x): x is string => !!x);
    const subjects = actor ? [actor, ...member?.roles.cache.keys() ?? []] : [];
    if (actor && (isController(ctx, actor) || ctx.store.trusted(subjects, scope, targets))) {
      ctx.log.write('info', 'trusted_audit', { actor, scope, target: entry.targetId, auditId: entry.id });
      return;
    }
    if (!actor) {
      await report(ctx, 'unknown_executor', null, { auditId: entry.id, action: entry.action, target: entry.targetId });
      return;
    }
    const weight = entry.action === AuditLogEvent.MemberPrune ? settings.combinedLimit : settings.rules[scope].weight;
    const totals = ctx.store.signal(entry.id, actor, scope, weight, Date.now(), Date.now() - settings.windowSeconds * 1000);
    const decision = decide(settings, scope, totals);
    ctx.log.write('info', 'audit_signal', { auditId: entry.id, actor, scope, target: entry.targetId, ...decision });
    if (!decision.triggered) return;
    const contain = this.cooldown(`audit:${actor}`, 30);
    if (!contain && scope !== 'permissions' && scope !== 'bots' && scope !== 'webhooks') return;
    const incident = await report(ctx, 'guard_triggered', actor, { auditId: entry.id, target: entry.targetId, action: entry.action, scope, mode: settings.mode, ...decision });
    if (settings.mode !== 'enforce') return;
    if (contain) ctx.store.enqueue('mitigate', { actor, incident, scope, targets, created: Date.now(), action: settings.action }, `mitigate:${incident}`, 0);
    if (scope === 'permissions') {
      const permissions = entry.changes.find(c => c.key === 'permissions');
      const allow = entry.changes.find(c => c.key === 'allow');
      if ([AuditLogEvent.RoleCreate, AuditLogEvent.RoleUpdate].includes(entry.action) && permissions?.new !== undefined) {
        ctx.store.enqueue('revokePermissions', { target: entry.targetId, before: String(permissions.old ?? '0'), after: String(permissions.new), actor, scope, targets, created: Date.now(), incident }, `permissions:${incident}`, 1);
      }
      if (entry.action === AuditLogEvent.MemberRoleUpdate && added?.length) {
        ctx.store.enqueue('revokeGrantedRoles', { target: entry.targetId, roleIds: added.map(r => r.id), actor, scope, targets, created: Date.now(), incident }, `granted:${incident}`, 1);
      }
      if ([AuditLogEvent.ChannelOverwriteCreate, AuditLogEvent.ChannelOverwriteUpdate].includes(entry.action) && allow?.new !== undefined) {
        const extra = entry.extra as { id?: string } | null;
        if (extra?.id) ctx.store.enqueue('revokeOverwrite', { channelId: entry.targetId, overwriteId: extra.id, before: String(allow.old ?? '0'), after: String(allow.new), actor, scope, targets, created: Date.now(), incident }, `overwrite:${incident}`, 1);
      }
    }
    if (entry.action === AuditLogEvent.BotAdd && entry.targetId) ctx.store.enqueue('removeBot', { actor: entry.targetId, incident, created: Date.now() }, `bot:${incident}`, 1);
    if ([AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookUpdate].includes(entry.action) && entry.targetId) ctx.store.enqueue('removeWebhook', { webhookId: entry.targetId, incident, created: Date.now() }, `webhook:${incident}`, 1);
  }
  async join(member: GuildMember) {
    const ctx = this.ctx;
    const settings = ctx.store.settings();
    if (!settings.raid.enabled || member.user.bot || isController(ctx, member.id)) return;
    const now = Date.now();
    const young = now - member.user.createdTimestamp < settings.raid.youngAccountHours * 3600_000;
    this.joins = this.joins.filter(j => now - j.time <= settings.raid.windowSeconds * 1000);
    this.joins.push({ id: member.id, time: now, young });
    const triggered = this.joins.length >= settings.raid.joins && this.joins.filter(j => j.young).length / this.joins.length >= settings.raid.youngRatio;
    let hold = ctx.store.get<number>('raidUntil') ?? 0;
    if (triggered && this.cooldown('raid', settings.raid.windowSeconds)) {
      hold = now + settings.raid.holdMinutes * 60_000;
      ctx.store.set('raidUntil', hold);
      await report(ctx, 'raid_detected', null, { joins: this.joins.length, young: this.joins.filter(j => j.young).length, until: hold, mode: settings.mode });
    }
    if (settings.mode === 'enforce' && hold > now) {
      const candidates = triggered ? this.joins.filter(j => j.young) : young ? [{ id: member.id }] : [];
      for (const candidate of candidates) ctx.store.enqueue('timeout', { actor: candidate.id, minutes: settings.raid.holdMinutes, reason: 'Guard raid karantina', created: now, scope: 'raid', targets: [] }, `raid:${candidate.id}:${Math.floor(hold / 60000)}`, 2);
    }
  }
  async message(message: Message) {
    const ctx = this.ctx;
    if (message.guildId !== ctx.guild.id || message.system || message.author.id === ctx.client.user?.id) return;
    if (message.author.bot && !message.webhookId) return;
    const settings = ctx.store.settings();
    if (!settings.spam.enabled || isController(ctx, message.author.id)) return;
    const targets = [message.channelId, 'parentId' in message.channel ? message.channel.parentId : null].filter((x): x is string => !!x);
    if (ctx.store.trusted([message.author.id, ...message.member?.roles.cache.keys() ?? []], 'spam', targets)) return;
    const now = Date.now();
    const actor = message.webhookId ?? message.author.id;
    const text = ctx.env.messageContent ? message.content.normalize('NFKC').trim().toLowerCase() : '';
    const hash = text ? createHash('sha256').update(text).digest('hex') : '';
    const history = (this.messages.get(actor) ?? []).filter(x => now - x.time < settings.spam.windowSeconds * 1000);
    history.push({ time: now, hash });
    this.messages.set(actor, history.slice(-100));
    const reasons: string[] = [];
    if (history.length >= settings.spam.messages) reasons.push('flood');
    if (hash && history.filter(x => x.hash === hash).length >= settings.spam.duplicateLimit) reasons.push('duplicate');
    if (message.mentions.users.size + message.mentions.roles.size >= settings.spam.mentionLimit || message.mentions.everyone) reasons.push('mention');
    if (ctx.env.messageContent) {
      if (settings.spam.blockInvites && /(?:discord\.gg|discord(?:app)?\.com\/invite)\//i.test(text)) reasons.push('invite');
      for (const match of text.matchAll(/https?:\/\/[^\s<>]+/gi)) {
        try { if (domainBlocked(new URL(match[0]).hostname, settings.spam.blockedDomains)) reasons.push('domain'); } catch {}
      }
      if (message.attachments.some(a => settings.spam.blockedExtensions.some(ext => a.name.toLowerCase().endsWith(ext)))) reasons.push('attachment');
    }
    if (!reasons.length || !this.cooldown(`spam:${actor}`, 10)) return;
    const incident = await report(ctx, 'spam_detected', actor, { reasons: [...new Set(reasons)], channelId: message.channelId, messageId: message.id, mode: settings.mode });
    if (settings.mode !== 'enforce') return;
    ctx.store.enqueue('deleteMessage', { channelId: message.channelId, messageId: message.id, created: now }, `message:${message.id}`, 3);
    if (message.webhookId) ctx.store.enqueue('removeWebhook', { webhookId: message.webhookId, incident, created: now }, `spamwebhook:${incident}`, 1);
    else ctx.store.enqueue('timeout', { actor: message.author.id, minutes: settings.spam.timeoutMinutes, reason: `Guard ${incident}`, scope: 'spam', targets, created: now }, `spam:${incident}`, 2);
  }
  sweep() {
    const cutoff = Date.now() - 60_000;
    for (const [id, list] of this.messages) if ((list.at(-1)?.time ?? 0) < cutoff) this.messages.delete(id);
    this.ctx.store.db.prepare("DELETE FROM kv WHERE key LIKE 'cooldown:%' AND CAST(value AS INTEGER)<?").run(Date.now());
  }
}
