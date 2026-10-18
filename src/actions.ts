import { PermissionFlagsBits as P, OverwriteType, type GuildMember } from 'discord.js';
import { canRestoreOverwrite, dangerous } from './policy.ts';
import { report, isController, type Context } from './context.ts';

export async function strip(ctx: Context, member: GuildMember, reason: string) {
  if (isController(ctx, member.id) || member.id === ctx.client.user?.id) throw new Error('Korunan yöneticiye müdahale edilmedi.');
  const me = await ctx.guild.members.fetchMe();
  if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) throw new Error('Hedef rol hiyerarşisinin üzerinde.');
  const risky = member.roles.cache.filter(r => r.id !== ctx.guild.id && (r.permissions.bitfield & dangerous) !== 0n);
  const removed: string[] = [];
  const blocked: string[] = [];
  for (const role of risky.values()) {
    if (!role.editable || role.managed) { blocked.push(role.id); continue; }
    await member.roles.remove(role.id, reason);
    removed.push(role.id);
  }
  await report(ctx, 'roles_stripped', member.id, { removed, blocked });
  if (blocked.length) throw new Error(`Kaldırılamayan tehlikeli roller: ${blocked.join(',')}`);
  return removed;
}

export type LockEntry = { channelId: string; existed: boolean; before: { allow: string; deny: string }; applied: { allow: string; deny: string }; state: 'planned' | 'applied' | 'restored' | 'conflict' };
export type LockState = { active: boolean; entries: LockEntry[]; created: number };
const lockedBits = P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads | P.AddReactions;
export async function lockdown(ctx: Context, enable: boolean) {
  let lock = ctx.store.get<LockState>('lockdown');
  if (enable) {
    if (lock?.active && lock.entries.every(e => e.state === 'applied')) return;
    if (!lock?.active) {
      const ids = ctx.store.settings().lockdownChannelIds;
      if (!ids.length) throw new Error('Önce lockdown kanallarını yapılandırın.');
      lock = { active: true, created: Date.now(), entries: [] };
      for (const id of ids) {
        const channel = await ctx.guild.channels.fetch(id);
        if (!channel || !('permissionOverwrites' in channel)) throw new Error(`Kanal desteklenmiyor: ${id}`);
        const old = channel.permissionOverwrites.cache.get(ctx.guild.id);
        const before = { allow: (old?.allow.bitfield ?? 0n).toString(), deny: (old?.deny.bitfield ?? 0n).toString() };
        lock.entries.push({ channelId: id, existed: !!old, before, applied: { allow: (BigInt(before.allow) & ~lockedBits).toString(), deny: (BigInt(before.deny) | lockedBits).toString() }, state: 'planned' });
      }
      ctx.store.set('lockdown', lock);
    }
    for (const item of lock.entries.filter(e => e.state === 'planned')) {
      const channel = await ctx.guild.channels.fetch(item.channelId);
      if (!channel || !('permissionOverwrites' in channel)) continue;
      const current = channel.permissionOverwrites.cache.get(ctx.guild.id);
      const actual = { allow: (current?.allow.bitfield ?? 0n).toString(), deny: (current?.deny.bitfield ?? 0n).toString() };
      if (!canRestoreOverwrite(actual, item.before) && !canRestoreOverwrite(actual, item.applied)) { item.state = 'conflict'; ctx.store.set('lockdown', lock); continue; }
      await ctx.client.rest.put(`/channels/${channel.id}/permissions/${ctx.guild.id}`, { body: { type: OverwriteType.Role, allow: item.applied.allow, deny: item.applied.deny }, reason: 'Guard lockdown' });
      item.state = 'applied'; ctx.store.set('lockdown', lock);
    }
  } else {
    if (!lock?.active) return;
    for (const item of lock.entries.filter(e => e.state !== 'restored')) {
      const channel = await ctx.guild.channels.fetch(item.channelId);
      if (!channel || !('permissionOverwrites' in channel)) { item.state = 'restored'; ctx.store.set('lockdown', lock); continue; }
      const old = channel.permissionOverwrites.cache.get(ctx.guild.id);
      const current = { allow: (old?.allow.bitfield ?? 0n).toString(), deny: (old?.deny.bitfield ?? 0n).toString() };
      if (canRestoreOverwrite(current, item.before)) item.state = 'restored';
      else if (!canRestoreOverwrite(current, item.applied)) item.state = 'conflict';
      else {
        if (item.existed) await ctx.client.rest.put(`/channels/${channel.id}/permissions/${ctx.guild.id}`, { body: { type: OverwriteType.Role, allow: item.before.allow, deny: item.before.deny }, reason: 'Guard lockdown release' });
        else if (old) await old.delete('Guard lockdown release');
        item.state = 'restored';
      }
      ctx.store.set('lockdown', lock);
    }
    lock.active = lock.entries.some(e => e.state !== 'restored'); ctx.store.set('lockdown', lock);
  }
  await report(ctx, enable ? 'lockdown_on' : 'lockdown_off', null, lock);
}

export async function timeout(ctx: Context, actor: string, minutes: number, reason: string) {
  const member = await ctx.guild.members.fetch(actor);
  if (isController(ctx, actor) || actor === ctx.client.user?.id || member.user.bot) throw new Error('Korunan hesap için timeout uygulanmadı.');
  if (!member.moderatable) throw new Error('Timeout için izin veya rol sırası uygun değil.');
  await member.timeout(minutes * 60_000, reason);
}
