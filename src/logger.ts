import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export class Logger {
  constructor(private dir: string, private secrets: string[] = []) {}
  redact(value: unknown): string {
    let text = typeof value === 'string' ? value : JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
    for (const secret of this.secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
    return text.replace(/https:\/\/[^\s"/]+\/api\/webhooks\/\d+\/[^\s"]+/g, '[WEBHOOK]');
  }
  write(level: string, event: string, data: unknown = {}) {
    const time = new Date().toISOString();
    const line = this.redact({ time, level, event, data });
    console.log(line);
    appendFileSync(join(this.dir, `${time.slice(0, 10)}.jsonl`), line + '\n', { mode: 0o600 });
  }
  error(event: string, error: unknown) { this.write('error', event, { message: error instanceof Error ? error.message : String(error) }); }
}
