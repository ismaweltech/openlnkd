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
      await this.delay(2000, 3000);

      // Debug: log ALL top-card buttons so we can see what's actually on the page
      const topCardButtons = await page.evaluate(() => {
        const mainSection = document.querySelector('main section:first-of-type, .pv-top-card, .ph5');
        const scope = mainSection ?? document.body;
        return Array.from(scope.querySelectorAll('button')).map(b => ({
          text: b.textContent?.trim().substring(0, 40) ?? '',
          aria: b.getAttribute('aria-label')?.substring(0, 60) ?? '',
        }));
      }).catch(() => [] as any[]);
      this.logger.debug(`Top-card buttons: ${JSON.stringify(topCardButtons)}`);

      // Extraer nombre y headline del perfil
      const name = await page.$eval(
        'h1',
        (el) => el.textContent?.trim() ?? '',
      ).catch(() => '');

      const headline = await page.$eval(
        '.text-body-medium.break-words, [class*="pv-text-details"] .text-body-medium',
        (el) => el.textContent?.trim() ?? '',
      ).catch(() => null);

      // Buscar botón "Connect" / "Conectar"
      const connectBtn = await this.findConnectButton(page);
      if (!connectBtn) {
        return { ok: false, message: 'Connect button not found — already connected or not available' };
      }

      await connectBtn.click();
      await this.delay(1500, 2000);

      // Helper: find a visible button by matching its text content
      const findBtnByText = async (needles: string[]): Promise<any | null> => {
        const btns = await page.$$('button');
        for (const btn of btns) {
          const txt = ((await btn.textContent().catch(() => '')) ?? '').trim().toLowerCase();
          if (needles.some((n) => txt.includes(n.toLowerCase()))) return btn;
        }
        return null;
      };

      if (message) {
        // With note: click "Añadir una nota" then fill in the textarea
        const addNoteBtn = await findBtnByText(['add a note', 'añadir una nota', 'add note', 'añadir nota']);
        if (addNoteBtn) {
          await addNoteBtn.click();
          await this.delay(500, 800);
          const textarea = await page.$('textarea[name="message"], textarea[id*="custom-message"]');
          if (textarea) {
            await textarea.type(message.substring(0, 300), { delay: 30 });
            await this.delay(400, 600);
          }
        }
        // Now hit the final Send button
        const sendBtn = await findBtnByText(['send', 'enviar']);
        if (!sendBtn) {
          return { ok: false, message: 'Send button not found after writing note' };
        }
        await sendBtn.click();
      } else {
        // No note: look for "Enviar sin nota" / "Send without a note"
        const sendNoNote = await findBtnByText([
          'send without a note', 'enviar sin nota', 'send without note',
        ]);
        if (sendNoNote) {
          await sendNoNote.click();
        } else {
          // Fallback — modal may not have appeared (e.g. already handled), try generic Send
          const sendBtn = await findBtnByText(['send', 'enviar']);
          if (!sendBtn) {
            return { ok: false, message: 'Send button not found after clicking Connect' };
          }
          await sendBtn.click();
        }
      }

      await this.delay(1000, 1500);

      // Guardar en DB
      await this.upsertConnection({ name, headline, profileUrl, note: message });
      this.logger.log(`Invite sent to ${name}`);
      return { ok: true, message: `Invite sent to ${name}` };
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

  /**
   * Find and return the "Conectar" / "Connect" button on a LinkedIn profile page.
   *
   * LinkedIn often hides "Connect" inside the "Más" (More) overflow dropdown.
   * We scope ALL searches to the profile top-card section to avoid accidentally
   * clicking "Conectar" buttons that appear in the "Más perfiles para ti"
   * (suggested profiles) carousel at the bottom of the page.
   *
   * Flow:
   *   1. Check if there is a direct Connect button in the top-card area.
   *   2. If not, click the "Más" / "More actions" button → dropdown opens.
   *   3. Find "Conectar" inside the dropdown and return it.
   */
  private async findConnectButton(page: any): Promise<any | null> {
    // ── Scope to the profile top-card ─────────────────────────────────────────
    // LinkedIn's profile header is always the first <section> inside <main>,
    // contained in one of these selectors. We look for the first match.
    const TOP_CARD_SEL =
      '.pv-top-card, ' +
      'section.artdeco-card:first-of-type, ' +
      '.ph5.pb5, ' +
      'main section:first-of-type';

    const topCard = await page.$(TOP_CARD_SEL).catch(() => null);
    const scope = topCard ?? page; // fall back to full page if we can't narrow

    // ── 1. Direct "Conectar" button (visible without dropdown) ───────────────
    const CONNECT_ARIA = [
      '[aria-label*="Invite"][aria-label*="connect" i]',
      '[aria-label*="Connect" i]',
      '[aria-label*="Conectar" i]',
    ];
    for (const sel of CONNECT_ARIA) {
      const btn = await scope.$(sel).catch(() => null);
      if (btn && await btn.isVisible().catch(() => false)) {
        this.logger.debug('Connect button found directly in top-card');
        return btn;
      }
    }

    // Also try by text content, but only inside the top-card
    const topCardBtns: any[] = topCard ? await topCard.$$('button').catch(() => []) : [];
    for (const btn of topCardBtns) {
      const txt = ((await btn.textContent().catch(() => '')) ?? '').trim().toLowerCase();
      if (txt === 'conectar' || txt === 'connect') {
        this.logger.debug(`Connect button found by text inside top-card: "${txt}"`);
        return btn;
      }
    }

    // ── 2. Click the "Más" / "More actions" dropdown in the top-card ─────────
    const moreBtn = await this.findMoreActionsButton(page, topCard);
    if (!moreBtn) {
      this.logger.debug('No direct Connect button and no "Más" button found');
      return null;
    }

    this.logger.debug('Clicking "Más" to open overflow menu');
    await moreBtn.click();

    // ── 3. Find "Conectar" in the dropdown using innerText ────────────────────
    // Important: use innerText (rendered visible text) NOT textContent, because
    // textContent includes SVG <title> hidden text which confuses exact matching.
    // Also: .artdeco-dropdown__content is the reliable container LinkedIn uses.
    const DROPDOWN = '.artdeco-dropdown__content';
    await page.waitForSelector(DROPDOWN, { timeout: 3000 }).catch(() => {});
    await this.delay(300, 400); // let items fully render

    // Grab all clickable items inside the dropdown
    const items: any[] = await page.$$(
      `${DROPDOWN} a, ${DROPDOWN} button, ${DROPDOWN} [role="menuitem"], ${DROPDOWN} li`,
    ).catch(() => []);

    for (const item of items) {
      // innerText respects CSS visibility and excludes hidden SVG text
      const innerText: string = await page
        .evaluate((el: Element) => (el as HTMLElement).innerText?.trim().toLowerCase() ?? '', item)
        .catch(() => '');

      this.logger.debug(`Dropdown innerText: "${innerText.substring(0, 40)}"`);

      if (innerText === 'conectar' || innerText === 'connect') {
        this.logger.debug('Found "Conectar" via innerText — returning');
        return item;
      }
    }

    this.logger.debug('Dropdown opened but no "Conectar" found. Items: ' + items.length);
    return null;
  }

  /** Find the "Más acciones" / "More actions" button scoped to the top-card */
  private async findMoreActionsButton(page: any, topCard: any): Promise<any | null> {
    const MORE_ARIA = [
      'button[aria-label*="Más acciones" i]',
      'button[aria-label*="More actions" i]',
      'button[aria-label*="más" i]',
    ];

    const scope = topCard ?? page;
    for (const sel of MORE_ARIA) {
      const btn = await scope.$(sel).catch(() => null);
      if (btn && await btn.isVisible().catch(() => false)) return btn;
    }

    // Fallback: text-based search inside top-card only
    const buttons: any[] = topCard ? await topCard.$$('button').catch(() => []) : [];
    for (const btn of buttons) {
      const label = ((await btn.getAttribute('aria-label').catch(() => '')) ?? '').toLowerCase();
      const txt = ((await btn.textContent().catch(() => '')) ?? '').trim().toLowerCase();
      if (
        label.includes('más acciones') || label.includes('more actions') ||
        txt === 'más' || txt === 'more'
      ) {
        return btn;
      }
    }

    return null;
  }

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
