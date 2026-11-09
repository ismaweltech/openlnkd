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

      // The name was the <h1> until 2026-11; now it's the top card's first <h2>.
      // The page title ("(3) Nombre Apellidos | LinkedIn") is the stable fallback.
      let name = await page.$eval('main h1, main h2', (el) => el.textContent?.trim() ?? '').catch(() => '');
      if (!name) name = (await page.title().catch(() => '')).replace(/^\(\d+\)\s*/, '').replace(/\s*\|\s*LinkedIn.*$/i, '').trim();
      const headline = await page
        .$eval('.text-body-medium.break-words, [class*="pv-text-details"] .text-body-medium',
          (el) => el.textContent?.trim() ?? '')
        .catch(() => null);

      // ── Step 1: open the "Connect" action ─────────────────────────────────
      // Since 2026-11 the top card's actions are links: "Conectar" is
      // <a href="/preload/custom-invite/?vanityName=<slug>">. The only <button>s
      // labelled "Conectar" are in the "people you may know" sidebar, so a loose
      // match would invite SOMEONE ELSE. Only accept controls tied to this exact
      // profile: the invite link with its slug, or "Invita a <name> a conectar".
      const slug = decodeURIComponent(profileUrl.match(/\/in\/([^/?#]+)/)?.[1] ?? '').toLowerCase();
      const step1 = await page.evaluate(({ slug, name }) => {
        const norm = (x: string) => x.replace(/\s+/g, ' ').trim().toLowerCase();
        const forThisProfile = (el: Element) => {
          const href = el.getAttribute('href') ?? '';
          if (href.includes('/preload/custom-invite/')) {
            const v = new URL(href, location.origin).searchParams.get('vanityName') ?? '';
            return decodeURIComponent(v).toLowerCase() === slug;
          }
          const a = norm(el.getAttribute('aria-label') ?? '');
          const who = a.match(/^invita a (.+) a conectar$/)?.[1] ?? a.match(/^invite (.+) to connect$/)?.[1];
          return !!who && !!name && who === norm(name);
        };
        const targets = Array.from(document.querySelectorAll<HTMLElement>('main a, main button'));
        const i = targets.findIndex((el) => forThisProfile(el) && el.getBoundingClientRect().width > 0);
        if (i >= 0) {
          targets[i].setAttribute('data-openlnkd-connect', '1'); // clicked below with a real mouse event
          return 'direct';
        }

        // Degree badge next to the name ("· 1er" / "· 1st"): already connected.
        const h1 = document.querySelector('main h1, main h2'); // the name heading
        const card = (h1?.closest('section') ?? h1?.parentElement?.parentElement?.parentElement) as HTMLElement | undefined;
        if (card && /[·•]\s*(1er|1st)\b/.test(card.innerText ?? '')) return 'connected';
        if (card && /^(pendiente|pending)$/m.test(card.innerText ?? '')) return 'pending';

        // Otherwise the top card's "Más / More" overflow: the first one just below the name.
        const top = h1?.getBoundingClientRect().top ?? 0;
        const more = Array.from(document.querySelectorAll<HTMLButtonElement>('main button')).find((b) => {
          const a = norm(b.getAttribute('aria-label') ?? '');
          const y = b.getBoundingClientRect().top;
          return ['más', 'more', 'more actions'].includes(a) && y >= top && y - top < 500;
        });
        if (!more) return 'no-connect';
        more.setAttribute('data-openlnkd-more', '1');
        return 'opened-more';
      }, { slug, name });

      if (step1 === 'connected') {
        return { ok: false, message: 'Already a 1st-degree connection — nothing sent' };
      }
      if (step1 === 'pending') {
        return { ok: false, message: 'Invite already pending — nothing sent' };
      }
      if (step1 === 'no-connect') {
        return { ok: false, message: 'No "Connect" option on this profile (Follow-only or restricted)' };
      }

      // The new links ignore a synthetic el.click(): use real clicks.
      if (step1 === 'direct') {
        await page.locator('[data-openlnkd-connect]').first().click({ timeout: 10000 });
      } else {
        await page.locator('[data-openlnkd-more]').first().click({ timeout: 10000 });
        await this.delay(700, 1100);
        // Playwright locators pierce the shadow root LinkedIn renders menus and modals in.
        const items = page.locator('[role="menuitem"]:visible, [role="menu"] :is(a, button):visible');
        const texts = (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
        const idx = texts.findIndex((t) => /^(conectar|connect)$/i.test(t));
        if (idx < 0) {
          if (texts.some((t) => /eliminar contacto|remove connection/i.test(t))) {
            return { ok: false, message: 'Already a 1st-degree connection — nothing sent' };
          }
          return { ok: false, message: 'No "Connect" option on this profile (Follow-only or restricted)' };
        }
        await items.nth(idx).click({ timeout: 10000 });
      }

      // ── Step 2: the invite dialog (optional note) and send ────────────────
      // It lives inside #interop-outlet's shadow root; only Playwright locators
      // reach it. The page also has unrelated dialogs (ad feedback with its own
      // "Enviar"), so scope to the invitation one.
      const dialog = page.locator('[role="dialog"]:visible').filter({ hasText: /invitaci|invitation/i }).first();
      if (!(await dialog.waitFor({ timeout: 10000 }).then(() => true).catch(() => false))) {
        return { ok: false, message: 'The invite dialog did not open' };
      }
      // Safety net: never send an invite meant for someone else.
      const dialogText = (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ');
      if (name && !dialogText.toLowerCase().includes(name.replace(/\s+/g, ' ').toLowerCase())) {
        return { ok: false, message: `The invite dialog is not for ${name} — nothing sent` };
      }
      await this.delay(600, 1000);

      const button = (re: RegExp) => dialog.locator('button:visible').filter({ hasText: re }).first();
      let send = button(/^\s*(enviar sin nota|send without a note|send without note)\s*$/i);
      if (message) {
        await button(/a(ñ|n)adir (una )?nota|add a? ?note/i).click({ timeout: 5000 }).catch(() => {});
        await this.delay(500, 800);
        const note = page.locator('[role="dialog"]:visible textarea').first();
        if (!(await note.isVisible().catch(() => false))) {
          return { ok: false, message: 'Could not open the note field in the invite dialog' };
        }
        await note.fill(message.substring(0, 300));
        await this.delay(400, 600);
        send = page.locator('[role="dialog"]:visible button:visible').filter({ hasText: /^\s*(enviar|send)\s*$/i }).first();
      }

      if (!(await send.isVisible().catch(() => false)) || !(await send.isEnabled().catch(() => false))) {
        return { ok: false, message: 'Could not find the Send button in the invite dialog' };
      }
      if (params.dryRun) {
        return { ok: true, message: `Dry run: invite for ${name || profileUrl} ready to send, nothing sent` };
      }
      await send.click({ timeout: 10000 });

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
