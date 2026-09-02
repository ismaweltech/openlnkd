import { Injectable, Logger } from '@nestjs/common';
import { BrowserService } from '../common/browser/browser.service';
import { DatabaseService } from '../common/database/database.service';
import { MessengerService } from '../common/messaging/messenger.service';
import { SessionService } from '../session/session.service';
import type { Connection, SendConnectionParams, SendMessageParams } from './connections.types';

@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger(ConnectionsService.name);

  constructor(
    private readonly browser: BrowserService,
    private readonly db: DatabaseService,
    private readonly messenger: MessengerService,
    private readonly session: SessionService,
  ) {}

  // ─── Enviar invitación de conexión ────────────────────────────────────────

  async sendInvite(params: SendConnectionParams): Promise<{ ok: boolean; message: string }> {
    await this.session.ensureAuthenticated();
    const { profileUrl, message } = params;

    const page = await this.browser.newPage();
    try {
      this.logger.log(`Sending invite to ${profileUrl}`);
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this.delay(2500, 3500);

      const name = await page.$eval('h1', (el) => el.textContent?.trim() ?? '').catch(() => '');
      const headline = await page
        .$eval('.text-body-medium.break-words, [class*="pv-text-details"] .text-body-medium',
          (el) => el.textContent?.trim() ?? '')
        .catch(() => null);

      // ── Step 1: open the "Connect" action ─────────────────────────────────
      // All clicks happen IN-PAGE (el.click()) to avoid Playwright's 30s
      // visibility waits. We scope to the profile action bar (right after the
      // <h1> name) so feed/post buttons can't produce false positives, and match
      // button text/aria EXACTLY — a substring match on "connect" wrongly hit
      // unrelated controls before. LinkedIn now shows many profiles as
      // "Follow"-only, where Connect is genuinely absent; that returns ok:false.
      const step1 = await page.evaluate(() => {
        const isConnect = (b: HTMLButtonElement) => {
          const t = (b.textContent ?? '').trim().toLowerCase();
          const a = (b.getAttribute('aria-label') ?? '').trim().toLowerCase();
          return t === 'conectar' || t === 'connect' || a === 'conectar' || a === 'connect' ||
            /^invitar? a .* a que (forme parte|conecte)/i.test(a) || /^invite .* to connect/i.test(a);
        };
        // Anchor on the profile ACTION BAR, not the whole page: it's the parent of
        // the primary action button ("Seguir"/"Mensaje"/"Conectar"/"Pendiente").
        // The feed below has its own "Más" buttons on every post — scoping here
        // stops those from producing a false positive.
        const primary = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => {
          const t = (b.textContent ?? '').trim().toLowerCase();
          const a = (b.getAttribute('aria-label') ?? '').trim().toLowerCase();
          return ['seguir', 'follow', 'mensaje', 'message', 'pendiente', 'pending'].includes(t) ||
            /^(mensaje|message|seguir a|follow) /i.test(a) || isConnect(b);
        });
        const bar = primary?.parentElement;
        if (!bar) return 'no-topcard';
        const barBtns = Array.from(bar.querySelectorAll<HTMLButtonElement>('button'));

        const direct = barBtns.find(isConnect);
        if (direct) { direct.click(); return 'direct'; }

        // Otherwise open the action bar's "Más / More actions" overflow (exact aria).
        const more = barBtns.find((b) => {
          const a = (b.getAttribute('aria-label') ?? '').trim().toLowerCase();
          return a === 'más' || a === 'more actions' || a === 'more';
        });
        if (!more) return 'no-connect';
        more.click();
        return 'opened-more';
      });

      if (step1 === 'no-topcard' || step1 === 'no-connect') {
        return { ok: false, message: 'No "Connect" option on this profile (Follow-only or restricted)' };
      }

      // If the overflow menu opened, click "Conectar" inside it.
      if (step1 === 'opened-more') {
        await this.delay(700, 1100);
        const inMenu = await page.evaluate(() => {
          const items = Array.from(
            document.querySelectorAll<HTMLElement>('[role="menuitem"], .artdeco-dropdown__content a, .artdeco-dropdown__content button'),
          );
          const connect = items.find((i) => /^(conectar|connect)$/i.test((i.innerText ?? '').replace(/\s+/g, ' ').trim()));
          if (connect) { connect.click(); return true; }
          return false;
        });
        if (!inMenu) {
          return { ok: false, message: 'No "Connect" option on this profile (Follow-only or restricted)' };
        }
      }

      // ── Step 2: handle the invite modal (optional note) and send ──────────
      await this.delay(1200, 1800);

      if (message) {
        // Open the note field, then type into it (typing needs a real handle).
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => {
            const t = (b.textContent ?? '').trim().toLowerCase();
            const a = (b.getAttribute('aria-label') ?? '').trim().toLowerCase();
            return /a(ñ|n)adir (una )?nota|add a? ?note/.test(t) || /a(ñ|n)adir (una )?nota|add a? ?note/.test(a);
          });
          btn?.click();
        });
        await this.delay(500, 800);
        const textarea = await page.$('textarea[name="message"], textarea[id*="custom-message"], div[role="dialog"] textarea');
        if (textarea) {
          await textarea.type(message.substring(0, 300), { delay: 25 }).catch(() => {});
          await this.delay(400, 600);
        }
      }

      // Click the final send button (Send / Enviar / Send without a note), in-page.
      const sent = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
        const match = (words: string[]) =>
          all.find((b) => {
            const t = (b.textContent ?? '').trim().toLowerCase();
            const a = (b.getAttribute('aria-label') ?? '').trim().toLowerCase();
            return words.some((w) => t === w || a === w) && b.offsetParent !== null && !b.disabled;
          });
        const btn =
          match(['enviar sin nota', 'send without a note', 'send without note']) ??
          match(['enviar', 'send']);
        if (btn) { btn.click(); return true; }
        return false;
      });

      if (!sent) {
        return { ok: false, message: 'Could not find the Send button in the invite dialog' };
      }

      await this.delay(1200, 1800);
      await this.upsertConnection({ name, headline, profileUrl, note: message });
      this.logger.log(`Invite sent to ${name || profileUrl}`);
      return { ok: true, message: `Invite sent to ${name || profileUrl}` };
    } finally {
      await page.close();
    }
  }

  // ─── Enviar mensaje a una conexión existente ──────────────────────────────

  async sendMessage(params: SendMessageParams): Promise<{ ok: boolean; message: string }> {
    await this.session.ensureAuthenticated();
    const { profileUrl, message } = params;

    // Delegates to MessengerService — the single implementation of "send a DM",
    // shared with outreach campaigns so LinkedIn UI changes are fixed in one place.
    const result = await this.messenger.sendMessage(profileUrl, message);

    if (result.ok) {
      await this.db.execute(
        'INSERT INTO messages (profile_url, content) VALUES (?, ?)',
        [profileUrl, message],
      );
      await this.db.execute(
        'UPDATE connections SET message_sent = 1 WHERE profile_url = ?',
        [profileUrl],
      );
    }

    return { ok: result.ok, message: result.message };
  }

  // ─── Listar conexiones registradas ───────────────────────────────────────

  async findAll(): Promise<Connection[]> {
    const rows = await this.db.query<any>('SELECT * FROM connections ORDER BY created_at DESC');
    return rows.map(this.rowToConnection);
  }

  // ─── Helpers privados ─────────────────────────────────────────────────────


  private async upsertConnection({ name, headline, profileUrl, note }: {
    name: string; headline: string | null; profileUrl: string; note?: string;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO connections (id, name, headline, profile_url, note)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (profile_url) DO NOTHING`,
      [
        `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name, headline, profileUrl, note ?? null,
      ],
    );
  }

  private rowToConnection(row: any): Connection {
    return { ...row, message_sent: Boolean(row.message_sent) };
  }

  private delay(min: number, max: number) {
    return new Promise((r) => setTimeout(r, Math.random() * (max - min) + min));
  }
}
