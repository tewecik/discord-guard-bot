import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits as P, SlashCommandBuilder, type Interaction, type ChatInputCommandInteraction } from 'discord.js';
import { settingsSchema, scopes } from './config.ts';
import { backupList, restorePreview } from './backup.ts';
import { isController, report, type Context } from './context.ts';

export const command = new SlashCommandBuilder().setName('guard').setDescription('Tewecik sunucu koruması').setDefaultMemberPermissions(P.Administrator)
  .addSubcommand(s => s.setName('setup').setDescription('Log kanalını ayarla').addChannelOption(o => o.setName('kanal').setDescription('Log kanalı').addChannelTypes(ChannelType.GuildText).setRequired(true)))
  .addSubcommand(s => s.setName('status').setDescription('Koruma durumunu göster'))
  .addSubcommand(s => s.setName('doctor').setDescription('İzinleri ve rol hiyerarşisini denetle'))
  .addSubcommand(s => s.setName('mode').setDescription('Çalışma modunu ayarla').addStringOption(o => o.setName('deger').setDescription('Mod').setRequired(true).addChoices({ name: 'Gözlem', value: 'observe' }, { name: 'Aktif müdahale', value: 'enforce' })))
  .addSubcommand(s => s.setName('policy').setDescription('Koruma kuralını düzenle').addStringOption(o => o.setName('modul').setDescription('Modül').setRequired(true).addChoices(...scopes.map(v => ({ name: v, value: v })))).addIntegerOption(o => o.setName('limit').setDescription('Pencere içindeki işlem sayısı').setMinValue(1).setMaxValue(100)).addIntegerOption(o => o.setName('agirlik').setDescription('Birleşik puan ağırlığı').setMinValue(1).setMaxValue(100)).addBooleanOption(o => o.setName('aktif').setDescription('Kural etkinliği')))
  .addSubcommand(s => s.setName('action').setDescription('Guard müdahale yöntemini seç').addStringOption(o => o.setName('deger').setDescription('Yöntem').setRequired(true).addChoices({ name: 'Tehlikeli rolleri kaldır', value: 'strip' }, { name: 'Banla', value: 'ban' })))
  .addSubcommand(s => s.setName('trust').setDescription('Süreli, kapsamlı güven izni ver').addStringOption(o => o.setName('hesap').setDescription('Kullanıcı veya rol kimliği').setRequired(true)).addStringOption(o => o.setName('kapsam').setDescription('İzin verilen işlem').setRequired(true).addChoices(...[...scopes, 'spam', 'raid', '*'].map(v => ({ name: v, value: v })))).addIntegerOption(o => o.setName('dakika').setDescription('Geçerlilik süresi').setRequired(true).setMinValue(1).setMaxValue(10080)).addStringOption(o => o.setName('hedef').setDescription('Kanal/kategori/rol kimliği; boşsa tüm hedefler')))
  .addSubcommand(s => s.setName('untrust').setDescription('Hesabın tüm güven izinlerini kaldır').addStringOption(o => o.setName('hesap').setDescription('Kullanıcı veya rol kimliği').setRequired(true)))
  .addSubcommand(s => s.setName('trusts').setDescription('Etkin güven izinlerini listele'))
  .addSubcommand(s => s.setName('lockchannels').setDescription('Acil durumda kilitlenecek kanalları ayarla').addStringOption(o => o.setName('kimlikler').setDescription('Virgülle ayrılmış kanal kimlikleri').setRequired(true)))
  .addSubcommand(s => s.setName('lockdown').setDescription('Acil durum kilidini aç veya kaldır').addBooleanOption(o => o.setName('aktif').setDescription('Kilit etkinliği').setRequired(true)))
  .addSubcommand(s => s.setName('backup').setDescription('Şifreli yapı yedeği oluştur'))
  .addSubcommand(s => s.setName('backups').setDescription('Son yedekleri listele'))
  .addSubcommand(s => s.setName('restore').setDescription('Recovery önizlemesi ve onay').addStringOption(o => o.setName('yedek').setDescription('Yedek UUID').setRequired(true)).addStringOption(o => o.setName('kapsam').setDescription('Geri yüklenecek yapı').setRequired(true).addChoices({ name: 'Roller', value: 'roles' }, { name: 'Kanallar ve eksik roller', value: 'channels' }, { name: 'Roller, kanallar ve temel ayarlar', value: 'all' })))
  .addSubcommand(s => s.setName('incident').setDescription('Olay kaydını göster').addStringOption(o => o.setName('kimlik').setDescription('Olay UUID; boşsa son olaylar')))
  .addSubcommand(s => s.setName('config').setDescription('Ayarları JSON olarak dışa aktar veya içe al').addAttachmentOption(o => o.setName('dosya').setDescription('İçe aktarılacak JSON ayar dosyası')))
  .addSubcommand(s => s.setName('raidclear').setDescription('Etkin raid penceresini kapat'));

const file = (name: string, value: unknown) => new AttachmentBuilder(Buffer.from(JSON.stringify(value, null, 2)), { name });
type Confirmation = { user: string; expires: number; kind: string; payload: unknown };
function ask(ctx: Context, user: string, kind: string, payload: unknown) {
  const nonce = randomUUID();
  ctx.store.set(`confirm:${nonce}`, { user, expires: Date.now() + 120_000, kind, payload });
  return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`guard:confirm:${nonce}`).setLabel('Onayla').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`guard:cancel:${nonce}`).setLabel('İptal').setStyle(ButtonStyle.Secondary));
}
export async function doctor(ctx: Context) {
  const me = await ctx.guild.members.fetchMe();
  const required = { ViewAuditLog: P.ViewAuditLog, ManageRoles: P.ManageRoles, ManageChannels: P.ManageChannels, ManageWebhooks: P.ManageWebhooks, KickMembers: P.KickMembers, BanMembers: P.BanMembers, ModerateMembers: P.ModerateMembers, ManageMessages: P.ManageMessages, ViewChannel: P.ViewChannel, SendMessages: P.SendMessages };
  return {
    ready: ctx.client.isReady(), missingPermissions: Object.entries(required).filter(([, p]) => !me.permissions.has(p)).map(([name]) => name),
    higherRoles: [...ctx.guild.roles.cache.values()].filter(r => r.id !== me.roles.highest.id && r.comparePositionTo(me.roles.highest) >= 0).map(r => ({ id: r.id, name: r.name })),
    messageContent: ctx.env.messageContent, botRole: me.roles.highest.id, mode: ctx.store.settings().mode,
    logChannel: ctx.store.settings().logChannelId, lastBackup: ctx.store.get('lastBackup') ?? null,
    note: 'Kanal bazlı izinler ve yönetilen roller ayrıca uygulanır. Sunucu sahibi denetlenmez.'
  };
}
async function confirm(ctx: Context, interaction: Interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('guard:')) return;
  const [, action, nonce] = interaction.customId.split(':');
  const key = `confirm:${nonce}`;
  const saved = ctx.store.get<Confirmation>(key);
  if (!saved || saved.user !== interaction.user.id || saved.expires < Date.now()) { await interaction.reply({ content: 'Onay geçersiz veya süresi dolmuş.', flags: MessageFlags.Ephemeral }); return; }
  await interaction.deferUpdate();
  ctx.store.delete(key);
  if (action === 'cancel') { await interaction.editReply({ content: 'İşlem iptal edildi.', components: [], files: [], attachments: [] }); return; }
  if (action !== 'confirm') return;
  if (saved.kind === 'mode') {
    const check = await doctor(ctx);
    if (check.missingPermissions.length) throw new Error(`Eksik izinler: ${check.missingPermissions.join(', ')}`);
    const settings = ctx.store.settings(); settings.mode = 'enforce'; ctx.store.saveSettings(settings);
  } else if (saved.kind === 'config') ctx.store.saveSettings(saved.payload);
  else if (saved.kind === 'action') {
    const settings = ctx.store.settings(); settings.action = 'ban'; ctx.store.saveSettings(settings);
  } else ctx.store.enqueue(saved.kind, saved.payload, `manual:${nonce}`, saved.kind === 'lockdown' ? 4 : 10);
  await report(ctx, 'command_confirmed', interaction.user.id, { kind: saved.kind });
  await interaction.editReply({ content: 'Onay alındı. İşlem kaydedildi; sonuçlar olay kayıtlarına yazılacak.', components: [], files: [], attachments: [] });
}
async function chat(ctx: Context, i: ChatInputCommandInteraction) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = ctx.store.settings();
  const sub = i.options.getSubcommand();
  switch (sub) {
    case 'setup': {
      settings.logChannelId = i.options.getChannel('kanal', true).id;
      const channel = await ctx.guild.channels.fetch(settings.logChannelId);
      const me = await ctx.guild.members.fetchMe();
      if (!channel || !channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) throw new Error('Log kanalına erişim, mesaj veya embed izni eksik.');
      ctx.store.saveSettings(settings); await i.editReply('Log kanalı kaydedildi. /guard doctor ile kurulumu denetleyin.'); break;
    }
    case 'status': await i.editReply({ files: [file('guard-status.json', { mode: settings.mode, action: settings.action, jobs: ctx.store.counts(), raidUntil: ctx.store.get('raidUntil') ?? null, lockdown: ctx.store.get('lockdown') ?? null, lastBackup: ctx.store.get('lastBackup') ?? null })] }); break;
    case 'doctor': await i.editReply({ files: [file('guard-doctor.json', await doctor(ctx))] }); break;
    case 'mode': {
      if (i.options.getString('deger', true) === 'observe') { settings.mode = 'observe'; ctx.store.saveSettings(settings); await i.editReply('Gözlem modu etkin. Bekleyen otomatik müdahaleler yürütülmeyecek.'); }
      else await i.editReply({ content: 'Aktif müdahale rol kaldırma, timeout ve yapılandırılmışsa ban uygular. Etkinleştirilsin mi?', components: [ask(ctx, i.user.id, 'mode', {})] }); break;
    }
    case 'policy': {
      const scope = i.options.getString('modul', true) as typeof scopes[number];
      const rule = settings.rules[scope];
      rule.limit = i.options.getInteger('limit') ?? rule.limit;
      rule.weight = i.options.getInteger('agirlik') ?? rule.weight;
      rule.enabled = i.options.getBoolean('aktif') ?? rule.enabled;
      ctx.store.saveSettings(settings); await i.editReply({ files: [file('policy.json', { [scope]: rule })] }); break;
    }
    case 'action': {
      if (i.options.getString('deger', true) === 'strip') { settings.action = 'strip'; ctx.store.saveSettings(settings); await i.editReply('Müdahale: tehlikeli rolleri kaldır.'); }
      else await i.editReply({ content: 'Guard eşiğini aşan hesaplar banlanacak. Onaylıyor musunuz?', components: [ask(ctx, i.user.id, 'action', {})] }); break;
    }
    case 'trust': {
      const subject = i.options.getString('hesap', true);
      const target = i.options.getString('hedef') ?? '*';
      if (!/^\d{17,22}$/.test(subject) || (target !== '*' && !/^\d{17,22}$/.test(target))) throw new Error('Geçerli Discord kimlikleri kullanın.');
      const scope = i.options.getString('kapsam', true);
      const minutes = i.options.getInteger('dakika', true);
      ctx.store.grant(subject, scope, target, Date.now() + minutes * 60_000, i.user.id);
      await i.editReply(`Süreli izin kaydedildi: ${subject}, ${scope}, hedef ${target}, ${minutes} dakika.`); break;
    }
    case 'untrust': ctx.store.revoke(i.options.getString('hesap', true)); await i.editReply('Güven izinleri kaldırıldı.'); break;
    case 'trusts': await i.editReply({ files: [file('trusts.json', ctx.store.trusts())] }); break;
    case 'lockchannels': {
      const ids = [...new Set(i.options.getString('kimlikler', true).split(',').map(s => s.trim()))];
      settings.lockdownChannelIds = ids;
      settingsSchema.parse(settings);
      for (const id of ids) if (!await ctx.guild.channels.fetch(id)) throw new Error(`Kanal bulunamadı: ${id}`);
      ctx.store.saveSettings(settings); await i.editReply('Lockdown kanalları kaydedildi.'); break;
    }
    case 'lockdown': await i.editReply({ content: 'Seçilen kanalların @everyone izinleri değiştirilecek. Yönetici ve özel izinli roller bu kilidi aşabilir. Onaylıyor musunuz?', components: [ask(ctx, i.user.id, 'lockdown', { enable: i.options.getBoolean('aktif', true) })] }); break;
    case 'backup': ctx.store.enqueue('backup', {}, `manual-backup:${i.id}`); await i.editReply('Şifreli yedekleme kuyruğa alındı. /guard backups ile kontrol edin.'); break;
    case 'backups': await i.editReply({ files: [file('backups.json', backupList(ctx))] }); break;
    case 'restore': {
      const backupId = i.options.getString('yedek', true);
      const part = i.options.getString('kapsam', true);
      const preview = await restorePreview(ctx, backupId);
      await i.editReply({ content: 'Recovery mevcut izinleri ve yapıyı değiştirebilir. Önizlemeyi inceleyip iki dakika içinde onaylayın. İşlem öncesinde yeni yedek alınır.', files: [file('recovery-preview.json', { ...preview, part })], components: [ask(ctx, i.user.id, 'restore', { backupId, part })] }); break;
    }
    case 'incident': {
      const id = i.options.getString('kimlik');
      await i.editReply({ files: [file('incidents.json', id ? ctx.store.incidentById(id) ?? { error: 'Olay bulunamadı.' } : ctx.store.incidents(25))] }); break;
    }
    case 'config': {
      const attachment = i.options.getAttachment('dosya');
      if (!attachment) { await i.editReply({ files: [file('guard-config.json', settings)] }); break; }
      const url = new URL(attachment.url);
      if (attachment.size > 65536 || url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) throw new Error('En fazla 64 KiB Discord eki yükleyin.');
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (!response.ok || !response.body) throw new Error('Dosya indirilemedi.');
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.byteLength; if (size > 65536) throw new Error('Dosya çok büyük.'); chunks.push(chunk); }
      const parsed = settingsSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (parsed.mode === 'enforce' && (await doctor(ctx)).missingPermissions.length) throw new Error('Aktif mod için doctor denetimini tamamlayın.');
      await i.editReply({ content: 'Ayarlar doğrulandı. Çalışma modu ve yaptırımlar dahil tüm yapılandırma değiştirilsin mi?', files: [file('new-config.json', parsed)], components: [ask(ctx, i.user.id, 'config', parsed)] }); break;
    }
    case 'raidclear': ctx.store.delete('raidUntil'); await i.editReply('Raid penceresi kapatıldı. Mevcut timeout süreleri korunur.'); break;
  }
  await report(ctx, 'command', i.user.id, { command: sub });
}
export async function handleInteraction(ctx: Context, interaction: Interaction) {
  if (!(interaction.isChatInputCommand() && interaction.commandName === 'guard') && !(interaction.isButton() && interaction.customId.startsWith('guard:'))) return;
  if (interaction.guildId !== ctx.guild.id || !isController(ctx, interaction.user.id)) {
    await interaction.reply({ content: 'Bu işlem yalnızca sunucu sahibi ve OWNER_IDS yöneticilerine açık.', flags: MessageFlags.Ephemeral }); return;
  }
  try {
    if (interaction.isChatInputCommand()) await chat(ctx, interaction);
    else await confirm(ctx, interaction);
  } catch (error) {
    ctx.log.error('command_failed', error);
    const content = `İşlem tamamlanamadı: ${ctx.log.redact(error instanceof Error ? error.message : String(error)).slice(0, 1500)}`;
    if (interaction.replied || interaction.deferred) await interaction.editReply({ content, components: [] });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}
