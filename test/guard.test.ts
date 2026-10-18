import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AuditLogEvent, Collection, PermissionFlagsBits as P, type GuildAuditLogsEntry, type Message } from 'discord.js';
import { Store } from '../src/store.ts';
import { defaults, settingsSchema } from '../src/config.ts';
import { addedDangerous, classify, decide, domainBlocked } from '../src/policy.ts';
import { seal, unseal } from '../src/backup.ts';
import { Engine } from '../src/engine.ts';
import { lockdown } from '../src/actions.ts';
import { command, handleInteraction } from '../src/commands.ts';
import type { Context } from '../src/context.ts';
import { Worker } from '../src/worker.ts';
import { setTimeout as sleep } from 'node:timers/promises';

const guildId = '111111111111111111';
const actorId = '222222222222222222';
function fixture() {
  const store = new Store(':memory:');
  const ctx = {
    store,
    client: { user: { id: '999999999999999999' }, rest: { put: async () => {} } },
    guild: { id: guildId, ownerId: '888888888888888888', members: { fetch: async () => ({ roles: { cache: new Collection() } }) }, channels: { cache: new Collection() }, roles: { cache: new Collection() } },
    env: { owners: [], messageContent: true },
    log: { write: () => {}, error: () => {} }
  } as unknown as Context;
  return { ctx, store, engine: new Engine(ctx) };
}
function entry(overrides: Record<string, unknown> = {}): GuildAuditLogsEntry {
  return { id: '777777777777777777', createdTimestamp: Date.now(), executorId: actorId, targetId: '333333333333333333', action: AuditLogEvent.ChannelDelete, changes: [], ...overrides } as unknown as GuildAuditLogsEntry;
}
function jobs(store: Store) { return store.db.prepare('SELECT kind,payload FROM jobs').all() as { kind: string; payload: string }[]; }

test('backup round trip authenticates ciphertext and wrong key', () => {
  const key = randomBytes(32);
  const value = { guildId, roles: [{ permissions: '12345678901234567890' }] };
  const data = seal(value, key);
  assert.deepEqual(unseal(data, key), value);
  assert.throws(() => unseal(data, randomBytes(32)));
  const tampered = Buffer.from(data); tampered[tampered.length - 1]! ^= 1;
  assert.throws(() => unseal(tampered, key));
  assert.throws(() => unseal(Buffer.from('VGB1'), key));
  assert.notDeepEqual(seal(value, key), seal(value, key));
});

test('combined attacks trigger across independently subthreshold modules', () => {
  assert.deepEqual(decide(defaults, 'roles', [{ scope: 'channels', count: 2, score: 4 }, { scope: 'roles', count: 2, score: 4 }]), { triggered: true, count: 2, score: 8 });
});

test('permissions compare bigints and detect only newly granted dangerous bits', () => {
  assert.equal(addedDangerous(P.Administrator, P.Administrator), false);
  assert.equal(addedDangerous(0n, P.Administrator), true);
  assert.equal(addedDangerous(P.Administrator, 0n), false);
  assert.equal(classify(AuditLogEvent.RoleUpdate, [{ key: 'permissions', old: '0', new: P.Administrator.toString() }]), 'permissions');
  assert.equal(classify(AuditLogEvent.MemberRoleUpdate, [], true), 'permissions');
  assert.equal(classify(AuditLogEvent.MessageDelete, []), undefined);
});

test('configuration rejects unknown options, invalid ranges and malformed domains', () => {
  assert.throws(() => settingsSchema.parse({ ...defaults, mode: 'anything' }));
  assert.throws(() => settingsSchema.parse({ ...defaults, unexpected: true }));
  assert.throws(() => settingsSchema.parse({ ...defaults, windowSeconds: -1 }));
  assert.throws(() => settingsSchema.parse({ ...defaults, spam: { ...defaults.spam, blockedDomains: ['https://example.com'] } }));
});

test('domain policies match actual subdomains without suffix confusion', () => {
  assert.equal(domainBlocked('a.bad.example', ['bad.example']), true);
  assert.equal(domainBlocked('BAD.EXAMPLE.', ['bad.example']), true);
  assert.equal(domainBlocked('notbad.example', ['bad.example']), false);
  assert.equal(domainBlocked('bad.example.evil.test', ['bad.example']), false);
});

test('trust is scoped to subject, operation, target and expiry', () => {
  const s = new Store(':memory:');
  try {
    s.grant(actorId, 'channels', 'target', 2000, 'owner');
    assert.equal(s.trusted([actorId], 'channels', ['target'], 1000), true);
    assert.equal(s.trusted([actorId], 'roles', ['target'], 1000), false);
    assert.equal(s.trusted([actorId], 'channels', ['other'], 1000), false);
    assert.equal(s.trusted([actorId], 'channels', ['target'], 2000), false);
    s.grant('role', '*', '*', 2000, 'owner');
    assert.equal(s.trusted([actorId, 'role'], 'roles', [], 1000), true);
    s.revoke('role');
    assert.equal(s.trusted(['role'], 'roles', [], 1000), false);
  } finally { s.close(); }
});

test('urgent containment does not wait behind recovery work', () => {
  const s = new Store(':memory:');
  try {
    s.enqueue('restore', {}, 'r', 10);
    s.enqueue('mitigate', {}, 'm', 0);
    s.enqueue('mitigate', {}, 'm', 0);
    assert.equal(s.take(true)?.kind, 'mitigate');
    assert.equal(s.take(true), undefined);
    assert.equal(s.take()?.kind, 'restore');
    assert.equal(s.take(), undefined);
  } finally { s.close(); }
});

test('running jobs recover after process restart and dedupe survives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tewecik-test-'));
  let s = new Store(join(dir, 'test.sqlite'));
  try {
    s.enqueue('restore', { id: 1 }, 'same');
    const job = s.take()!;
    assert.equal(job.attempts, 1);
    s.close(); s = new Store(join(dir, 'test.sqlite'));
    s.enqueue('restore', { id: 1 }, 'same');
    const retry = s.take()!;
    assert.equal(retry.id, job.id);
    assert.equal(retry.attempts, 2);
    s.finish(retry.id);
    assert.equal(s.take(), undefined);
  } finally { s.close(); rmSync(dir, { recursive: true }); }
});

test('duplicate audit delivery cannot double punish', async () => {
  const { store, engine } = fixture();
  try {
    const settings = structuredClone(defaults); settings.mode = 'enforce'; settings.rules.channels.limit = 1; store.saveSettings(settings);
    const e = entry(); await engine.audit(e); await engine.audit(e);
    assert.equal(jobs(store).filter(j => j.kind === 'mitigate').length, 1);
  } finally { store.close(); }
});

test('observe mode records incidents but queues no penalties', async () => {
  const { store, engine } = fixture();
  try {
    await engine.audit(entry({ action: AuditLogEvent.GuildUpdate }));
    assert.equal(jobs(store).length, 0);
    assert.equal(store.incidents().length, 1);
  } finally { store.close(); }
});

test('unknown actor and stale audit events do not punish', async () => {
  const { store, engine } = fixture();
  try {
    store.saveSettings({ ...defaults, mode: 'enforce' });
    await engine.audit(entry({ action: AuditLogEvent.GuildUpdate, executorId: null }));
    await engine.audit(entry({ id: '666666666666666666', action: AuditLogEvent.GuildUpdate, createdTimestamp: Date.now() - 120000 }));
    assert.equal(jobs(store).length, 0);
    assert.equal(store.incidents().length, 2);
  } finally { store.close(); }
});

test('own recovery changes and scoped maintenance are excluded', async () => {
  const { store, engine, ctx } = fixture();
  try {
    store.saveSettings({ ...defaults, mode: 'enforce' });
    await engine.audit(entry({ action: AuditLogEvent.GuildUpdate, executorId: ctx.client.user!.id }));
    store.grant(actorId, 'guild', '*', Date.now() + 60000, 'owner');
    await engine.audit(entry({ id: '666666666666666666', action: AuditLogEvent.GuildUpdate }));
    assert.equal(jobs(store).length, 0);
  } finally { store.close(); }
});

test('privilege escalation queues both containment and permission rollback', async () => {
  const { store, engine } = fixture();
  try {
    store.saveSettings({ ...defaults, mode: 'enforce' });
    await engine.audit(entry({ action: AuditLogEvent.RoleUpdate, changes: [{ key: 'permissions', old: '0', new: P.Administrator.toString() }] }));
    assert.deepEqual(jobs(store).map(j => j.kind), ['mitigate', 'revokePermissions']);
  } finally { store.close(); }
});

test('flood works without retaining or accessing message content', async () => {
  const { store, engine, ctx } = fixture();
  try {
    ctx.env.messageContent = false;
    store.saveSettings({ ...defaults, mode: 'enforce' });
    for (let n = 0; n < defaults.spam.messages; n++) {
      const message = { id: String(n), guildId, channelId: '333333333333333333', channel: {}, author: { id: actorId, bot: false }, member: { roles: { cache: new Collection() } }, mentions: { users: new Collection(), roles: new Collection(), everyone: false }, attachments: new Collection(), get content() { throw new Error('Content must not be read'); } } as unknown as Message;
      await engine.message(message);
    }
    assert.deepEqual(jobs(store).map(j => j.kind), ['deleteMessage', 'timeout']);
  } finally { store.close(); }
});

test('lockdown release preserves later administrator changes', async () => {
  const { store, ctx } = fixture();
  try {
    const channelId = '333333333333333333';
    const overwrite = { allow: { bitfield: P.ViewChannel }, deny: { bitfield: 0n } };
    const channel = { id: channelId, permissionOverwrites: { cache: new Collection([[guildId, overwrite]]) } };
    ctx.guild.channels.fetch = (async () => channel) as never;
    let writes = 0;
    ctx.client.rest.put = (async (_: unknown, options: { body: { allow: string; deny: string } }) => {
      writes++; overwrite.allow.bitfield = BigInt(options.body.allow); overwrite.deny.bitfield = BigInt(options.body.deny);
    }) as never;
    store.saveSettings({ ...defaults, lockdownChannelIds: [channelId] });
    await lockdown(ctx, true);
    assert.equal(writes, 1);
    overwrite.allow.bitfield |= P.AttachFiles;
    await lockdown(ctx, false);
    assert.equal(writes, 1);
    assert.equal((store.get<{ entries: { state: string }[] }>('lockdown'))!.entries[0]!.state, 'conflict');
  } finally { store.close(); }
});

test('slash command schema serializes all subcommands', () => {
  const json = command.toJSON();
  assert.equal(json.name, 'guard');
  assert.equal(json.options?.length, 17);
});

test('administrator permission alone does not grant bot configuration access', async () => {
  const { store, ctx } = fixture();
  try {
    let reply = '';
    const interaction = { isChatInputCommand: () => true, commandName: 'guard', guildId, user: { id: actorId }, reply: async (p: { content: string }) => { reply = p.content; } };
    await handleInteraction(ctx, interaction as never);
    assert.match(reply, /OWNER_IDS/);
    assert.equal(store.settings().mode, 'observe');
  } finally { store.close(); }
});

test('repeated privilege grants each get rollback despite actor cooldown', async () => {
  const { store, engine } = fixture();
  try {
    store.saveSettings({ ...defaults, mode: 'enforce' });
    const changes = [{ key: 'permissions', old: '0', new: P.Administrator.toString() }];
    await engine.audit(entry({ action: AuditLogEvent.RoleUpdate, changes }));
    await engine.audit(entry({ id: '666666666666666666', targetId: '444444444444444444', action: AuditLogEvent.RoleUpdate, changes }));
    assert.equal(jobs(store).filter(j => j.kind === 'mitigate').length, 1);
    assert.equal(jobs(store).filter(j => j.kind === 'revokePermissions').length, 2);
  } finally { store.close(); }
});

test('mass member prune triggers on the first audit event', async () => {
  const { store, engine } = fixture();
  try {
    store.saveSettings({ ...defaults, mode: 'enforce' });
    await engine.audit(entry({ action: AuditLogEvent.MemberPrune }));
    assert.equal(jobs(store).filter(j => j.kind === 'mitigate').length, 1);
  } finally { store.close(); }
});

test('worker rechecks observation mode before queued actions', async () => {
  const { store, ctx } = fixture();
  const worker = new Worker(ctx);
  try {
    ctx.client.isReady = (() => true) as never;
    store.enqueue('timeout', { actor: actorId, created: Date.now(), minutes: 10 }, 'test', 0);
    worker.start();
    await sleep(20);
    await worker.stop();
    const row = store.db.prepare('SELECT status FROM jobs WHERE dedupe=?').get('test');
    assert.equal(row?.status, 'done');
    assert.equal((store.incidents()[0] as { type: string }).type, 'action_expired');
  } finally { await worker.stop(); store.close(); }
});

test('worker preserves permissions changed since the audit event', async () => {
  const { store, ctx } = fixture();
  const worker = new Worker(ctx);
  try {
    store.saveSettings({ ...defaults, mode: 'enforce' });
    ctx.client.isReady = (() => true) as never;
    ctx.guild.roles.fetch = (async () => ({ permissions: { bitfield: P.ViewChannel }, setPermissions: async () => assert.fail('Must not overwrite a later change') })) as never;
    store.enqueue('revokePermissions', { actor: actorId, target: '333333333333333333', created: Date.now(), scope: 'permissions', before: '0', after: P.Administrator.toString() }, 'test', 0);
    worker.start();
    await sleep(20);
    await worker.stop();
    assert.equal((store.incidents()[0] as { type: string }).type, 'rollback_conflict');
    assert.equal(store.db.prepare('SELECT status FROM jobs WHERE dedupe=?').get('test')?.status, 'done');
  } finally { await worker.stop(); store.close(); }
});
