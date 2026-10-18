import { setTimeout as sleep } from 'node:timers/promises';
import { DiscordAPIError } from 'discord.js';
import { backup, restore } from './backup.ts';
import { lockdown, strip, timeout } from './actions.ts';
import { isController, report, type Context } from './context.ts';
import type { Job } from './store.ts';
import { dangerous } from './policy.ts';

export class Worker {
  private stopping = false;
  private tasks: Promise<void>[] = [];
  constructor(private ctx: Context) {}
  start() { this.tasks = [this.loop(true), this.loop(false)]; }
  async stop() { this.stopping = true; await Promise.all(this.tasks); }
  private async loop(urgent: boolean) {
    while (!this.stopping) {
      if (!this.ctx.client.isReady()) { await sleep(500); continue; }
      const job = this.ctx.store.take(urgent);
      if (!job) { await sleep(250); continue; }
      try {
        await this.execute(job);
        this.ctx.store.finish(job.id);
        this.ctx.log.write('info', 'job_complete', { id: job.id, kind: job.kind, attempts: job.attempts });
      } catch (error) {
        const retry = job.kind !== 'restore' && (!(error instanceof DiscordAPIError) || error.status >= 500 || error.status === 429);
        const detail = this.ctx.log.redact(error instanceof Error ? error.message : String(error));
        this.ctx.store.fail(job, detail, retry);
        this.ctx.log.error(`job:${job.kind}`, error);
        if (!retry || job.attempts >= 4 || job.kind === 'restore') {
          if (job.kind !== 'notify') await report(this.ctx, 'job_failed', null, { id: job.id, kind: job.kind, error: detail });
        }
      }
    }
  }
  private async execute(job: Job) {
    const ctx = this.ctx;
    const p = JSON.parse(job.payload);
    if (['mitigate', 'removeBot', 'removeWebhook', 'timeout', 'deleteMessage', 'revokePermissions', 'revokeGrantedRoles', 'revokeOverwrite'].includes(job.kind)) {
      if (ctx.store.settings().mode !== 'enforce' || Date.now() - p.created > 120_000) {
        await report(ctx, 'action_expired', p.actor ?? null, { job: job.id, kind: job.kind }); return;
      }
      if (p.actor && isController(ctx, p.actor)) return;
      if (p.actor && p.scope) {
        const member = await ctx.guild.members.fetch(p.actor).catch(() => null);
        if (ctx.store.trusted([p.actor, ...member?.roles.cache.keys() ?? []], p.scope, p.targets ?? [])) return;
      }
    }
    switch (job.kind) {
      case 'revokePermissions': {
        const role = await ctx.guild.roles.fetch(p.target);
        if (!role) return;
        if (role.permissions.bitfield.toString() !== p.after) { await report(ctx, 'rollback_conflict', p.actor, { incident: p.incident, target: p.target }); return; }
        if (!role.editable && role.id !== ctx.guild.id) throw new Error('Yetki geri alma için rol düzenlenemiyor.');
        const added = BigInt(p.after) & ~BigInt(p.before) & dangerous;
        await role.setPermissions(role.permissions.bitfield & ~added, `Guard ${p.incident}`); return;
      }
      case 'revokeGrantedRoles': {
        if (isController(ctx, p.target) || p.target === ctx.client.user?.id) throw new Error('Korunan hedefin rolü otomatik değiştirilmedi.');
        const member = await ctx.guild.members.fetch(p.target).catch(() => null);
        if (!member) return;
        for (const roleId of p.roleIds as string[]) {
          const role = member.roles.cache.get(roleId);
          if (role && (role.permissions.bitfield & dangerous) !== 0n) {
            if (!role.editable || role.managed) throw new Error('Verilen tehlikeli rol kaldırılamıyor.');
            await member.roles.remove(role.id, `Guard ${p.incident}`);
          }
        }
        return;
      }
      case 'revokeOverwrite': {
        const channel = await ctx.guild.channels.fetch(p.channelId);
        if (!channel || !('permissionOverwrites' in channel)) return;
        const overwrite = channel.permissionOverwrites.cache.get(p.overwriteId);
        if (!overwrite) return;
        if (overwrite.allow.bitfield.toString() !== p.after) { await report(ctx, 'rollback_conflict', p.actor, { incident: p.incident, channelId: p.channelId }); return; }
        const added = BigInt(p.after) & ~BigInt(p.before) & dangerous;
        await ctx.client.rest.put(`/channels/${channel.id}/permissions/${overwrite.id}`, { body: { type: overwrite.type, allow: (overwrite.allow.bitfield & ~added).toString(), deny: overwrite.deny.bitfield.toString() }, reason: `Guard ${p.incident}` }); return;
      }
      case 'mitigate': {
        const member = await ctx.guild.members.fetch(p.actor).catch(() => null);
        if (!member) { await report(ctx, 'actor_unavailable', p.actor, { incident: p.incident }); return; }
        if (p.action === 'ban') {
          if (!member.bannable) throw new Error('Hedef banlanamıyor: izin veya hiyerarşi.');
          await member.ban({ reason: `Guard ${p.incident}` });
        } else await strip(ctx, member, `Guard ${p.incident}`);
        await report(ctx, 'mitigation_complete', p.actor, { incident: p.incident, action: p.action });
        return;
      }
      case 'removeBot': {
        const member = await ctx.guild.members.fetch(p.actor).catch(() => null);
        if (!member) return;
        if (!member.user.bot || !member.kickable || member.id === ctx.client.user?.id) throw new Error('Bot çıkarılamadı.');
        await member.kick(`Guard ${p.incident}`); return;
      }
      case 'removeWebhook': {
        const hook = (await ctx.guild.fetchWebhooks()).get(p.webhookId);
        if (hook) await hook.delete(`Guard ${p.incident}`); return;
      }
      case 'timeout': await timeout(ctx, p.actor, p.minutes, p.reason); return;
      case 'deleteMessage': {
        const channel = await ctx.guild.channels.fetch(p.channelId);
        if (!channel?.isTextBased()) return;
        await channel.messages.delete(p.messageId).catch(error => { if (!(error instanceof DiscordAPIError) || error.code !== 10008) throw error; }); return;
      }
      case 'backup': await backup(ctx); return;
      case 'restore': {
        ctx.store.set('restore:active', p.backupId);
        try { await backup(ctx); await restore(ctx, p.backupId, p.part, job.id); }
        finally { ctx.store.delete('restore:active'); }
        return;
      }
      case 'lockdown': await lockdown(ctx, p.enable); return;
      case 'notify': {
        const channel = await ctx.guild.channels.fetch(p.channelId);
        if (!channel?.isTextBased() || !('send' in channel)) throw new Error('Log kanalı yazılabilir değil.');
        await channel.send({ embeds: [{ title: String(p.type).slice(0, 100), color: p.type.includes('fail') ? 0xef4444 : 0x6366f1, fields: [{ name: 'Olay', value: p.id }, { name: 'Hesap', value: p.actor ?? 'Sistem' }], timestamp: new Date().toISOString(), footer: { text: 'Tewecik Guard • /guard incident' } }], allowedMentions: { parse: [] } }); return;
      }
      default: throw new Error(`Bilinmeyen iş: ${job.kind}`);
    }
  }
}
