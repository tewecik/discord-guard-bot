import { REST, Routes } from 'discord.js';
import { environment } from './config.ts';
import { command } from './commands.ts';

const env = environment();
const rest = new REST({ version: '10' }).setToken(env.token);
const commands = await rest.get(Routes.applicationGuildCommands(env.applicationId, env.guildId)) as { id: string; name: string }[];
const existing = commands.find(c => c.name === command.name);
if (existing) await rest.patch(Routes.applicationGuildCommand(env.applicationId, env.guildId, existing.id), { body: command.toJSON() });
else await rest.post(Routes.applicationGuildCommands(env.applicationId, env.guildId), { body: command.toJSON() });
console.log('Guard komutları kaydedildi.');
