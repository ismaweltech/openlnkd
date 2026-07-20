import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DatabaseService } from '../common/database/database.service';
import { OutreachService, InboxMessage } from '../outreach/outreach.service';
import { SessionService } from '../session/session.service';

@Injectable()
export class WebhookService implements OnModuleInit {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly outreach: OutreachService,
    private readonly session: SessionService,
  ) {}

  async onModuleInit() {
    const isPostgres = process.env.DATABASE_URL?.startsWith('postgres');
    const idCol = isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    const tsType = isPostgres ? 'TIMESTAMP' : 'DATETIME';

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id ${idCol},
        name TEXT,
        url TEXT NOT NULL,
        secret TEXT,
        events TEXT DEFAULT '["new_messages"]',
        interval_sec INTEGER DEFAULT 300,
        active INTEGER DEFAULT 1,
        last_checked_at ${tsType},
        created_at ${tsType} DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migrate existing tables that are missing columns
    for (const col of [
      `ALTER TABLE webhooks ADD COLUMN name TEXT`,
      `ALTER TABLE webhooks ADD COLUMN events TEXT DEFAULT '["new_messages"]'`,
    ]) {
      await this.db.exec(col).catch(() => { /* column already exists */ });
    }
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_seen (
        fingerprint TEXT PRIMARY KEY,
        seen_at ${tsType} DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  @Interval(60_000)
  async tick() {
    const webhooks = await this.db.query<any>('SELECT * FROM webhooks WHERE active = 1');
    for (const wh of webhooks) {
      const lastMs = wh.last_checked_at ? new Date(wh.last_checked_at).getTime() : 0;
      const intervalMs = (wh.interval_sec ?? 300) * 1000;
      if (Date.now() - lastMs >= intervalMs) {
        await this.processWebhook(wh).catch((e) =>
          this.logger.warn(`Webhook ${wh.id} failed: ${e?.message}`),
        );
      }
    }
  }

  private async processWebhook(wh: any) {
    if (!(await this.session.isAuthenticated())) return;

    try {
      const messages = await this.outreach.readInbox(20);
      const newMessages: InboxMessage[] = [];

      for (const msg of messages) {
        const fp = this.fingerprint(msg);
        const seen = await this.db.queryOne('SELECT 1 FROM webhook_seen WHERE fingerprint = ?', [fp]);
        if (!seen) {
          newMessages.push(msg);
          await this.db.execute('INSERT INTO webhook_seen (fingerprint) VALUES (?)', [fp]);
        }
      }

      if (newMessages.length > 0) {
        await this.fireWebhook(wh, newMessages);
        this.logger.log(`Fired webhook ${wh.id} → ${newMessages.length} new message(s)`);
      }
    } finally {
      // Always update last_checked_at so the tick doesn't retry immediately on error
      await this.db.execute(
        'UPDATE webhooks SET last_checked_at = CURRENT_TIMESTAMP WHERE id = ?',
        [wh.id],
      );
    }
  }

  private async fireWebhook(wh: any, messages: InboxMessage[]) {
    const payload = {
      event: 'new_messages',
      timestamp: new Date().toISOString(),
      count: messages.length,
      messages,
    };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (wh.secret) headers['X-OpenLnkd-Secret'] = wh.secret;

    const res = await fetch(wh.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Webhook responded with ${res.status}`);
  }

  private fingerprint(msg: InboxMessage): string {
    return `${msg.senderUrl}::${(msg.preview ?? '').substring(0, 80)}`;
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async create(dto: { name?: string; url: string; secret?: string; events?: string[]; interval_sec?: number }) {
    const events = dto.events ? JSON.stringify(dto.events) : '["new_messages"]';
    const result = await this.db.execute(
      'INSERT INTO webhooks (name, url, secret, events, interval_sec) VALUES (?, ?, ?, ?, ?)',
      [dto.name ?? null, dto.url, dto.secret ?? null, events, dto.interval_sec ?? 300],
    );
    return this.findOne(result.lastInsertRowid!);
  }

  async findAll() {
    return this.db.query('SELECT * FROM webhooks ORDER BY created_at DESC');
  }

  async findOne(id: number) {
    const row = await this.db.queryOne<any>('SELECT * FROM webhooks WHERE id = ?', [id]);
    if (!row) throw new NotFoundException(`Webhook ${id} not found`);
    return row;
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.db.execute('DELETE FROM webhooks WHERE id = ?', [id]);
    return { ok: true };
  }

  async setActive(id: number, active: boolean) {
    await this.findOne(id);
    await this.db.execute('UPDATE webhooks SET active = ? WHERE id = ?', [active ? 1 : 0, id]);
    return this.findOne(id);
  }

  async test(id: number) {
    const wh = await this.findOne(id);
    const payload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      message: 'Test webhook from OpenLnkd — everything is wired up correctly.',
    };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (wh.secret) headers['X-OpenLnkd-Secret'] = wh.secret;
    try {
      const res = await fetch(wh.url, { method: 'POST', headers, body: JSON.stringify(payload) });
      return { ok: res.ok, status: res.status };
    } catch (e: any) {
      // Network error / DNS failure / connection refused — report cleanly, don't 500.
      return { ok: false, status: 0, error: e?.message ?? 'request failed' };
    }
  }
}
