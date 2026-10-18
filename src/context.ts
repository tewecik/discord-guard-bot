import type { Client, Guild } from 'discord.js';
import type { Environment } from './config.ts';
import type { Store } from './store.ts';
import type { Logger } from './logger.ts';

export type Context = { client: Client; guild: Guild; env: Environment; store: Store; log: Logger };
export async function report(ctx: Context, type: string, actor: string | null, data: unknown) {
  const id = ctx.store.incident(type, actor, data);
  ctx.log.write('info', type, { id, actor, data });
  const channelId = ctx.store.settings().logChannelId;
  if (channelId) ctx.store.enqueue('notify', { channelId, id, type, actor }, `notify:${id}`, 30);
  return id;
}
export function isController(ctx: Context, id: string) { return id === ctx.guild.ownerId || ctx.env.owners.includes(id); }
