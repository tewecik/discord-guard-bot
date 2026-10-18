import { AuditLogEvent, PermissionFlagsBits as P } from 'discord.js';
import type { Scope, Settings } from './config.ts';

export const dangerous = P.Administrator | P.ManageGuild | P.ManageRoles | P.ManageChannels | P.ManageWebhooks | P.BanMembers | P.KickMembers | P.ModerateMembers | P.MentionEveryone;
export function addedDangerous(before: string | bigint | undefined, after: string | bigint | undefined) {
  if (after === undefined) return false;
  return (BigInt(after) & ~BigInt(before ?? 0) & dangerous) !== 0n;
}
const groups: [Scope, number[]][] = [
  ['channels', [10, 11, 12, 13, 14, 15]], ['roles', [30, 31, 32, 25]],
  ['members', [20, 21, 22, 23]], ['bots', [28]], ['webhooks', [50, 51, 52]],
  ['guild', [1]], ['assets', [60, 61, 62, 90, 91, 92, 100, 101, 102]],
  ['automod', [140, 141, 142]], ['threads', [110, 111, 112]]
];
export function classify(action: number, changes: readonly { key: string; old?: unknown; new?: unknown }[], dangerousRoleAdded = false): Scope | undefined {
  if ((action === AuditLogEvent.RoleUpdate || action === AuditLogEvent.RoleCreate) && changes.some(c => c.key === 'permissions' && addedDangerous(c.old as string | undefined, c.new as string | undefined))) return 'permissions';
  if ([AuditLogEvent.ChannelOverwriteCreate, AuditLogEvent.ChannelOverwriteUpdate].includes(action) && changes.some(c => c.key === 'allow' && addedDangerous(c.old as string | undefined, c.new as string | undefined))) return 'permissions';
  if (action === AuditLogEvent.MemberRoleUpdate && dangerousRoleAdded) return 'permissions';
  return groups.find(([, actions]) => actions.includes(action))?.[0];
}
export function decide(settings: Settings, scope: Scope, totals: { scope: string; count: number; score: number }[]) {
  const count = totals.find(x => x.scope === scope)?.count ?? 0;
  const score = totals.reduce((sum, x) => sum + x.score, 0);
  return { triggered: count >= settings.rules[scope].limit || score >= settings.combinedLimit, count, score };
}
export function canRestoreOverwrite(current: { allow: string; deny: string }, applied: { allow: string; deny: string }) {
  return current.allow === applied.allow && current.deny === applied.deny;
}
export function domainBlocked(hostname: string, blocked: string[]) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return blocked.some(domain => normalized === domain.toLowerCase() || normalized.endsWith(`.${domain.toLowerCase()}`));
}
