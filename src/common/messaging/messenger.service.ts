import { Injectable, Logger } from '@nestjs/common';
import { BrowserService } from '../browser/browser.service';

export interface SendResult {
  ok: boolean;
  message: string;
  recipient?: string;
}

/**
 * Single source of truth for sending LinkedIn DMs.
 *
 * LinkedIn deprecated the legacy Voyager messaging endpoints (HTTP 410), so this
 * drives the UI. It deliberately does NOT click "Message" on the profile page:
 * that path is unreliable (the button is an <a> not a <button>, LinkedIn restores
 * previous chat bubbles, and the send button often stays disabled because React
 * never sees the input). The dedicated composer URL avoids all of it:
 *   • exactly ONE compose box on the page
 *   • the send button enables correctly after typing
 *   • the recipient is pre-filled, so it can be verified before sending
 *
 * Keep every LinkedIn-fragile selector for messaging in THIS file — when LinkedIn
 * changes its UI, this is the only place that needs updating.
 */
@Injectable()
export class MessengerService {
  private readonly logger = new Logger(MessengerService.name);

  /** Compose box: stable class on the messaging page, with aria-label fallbacks. */
  private static readonly COMPOSE_SELECTOR =
    'div.msg-form__contenteditable[contenteditable="true"], ' +
    'div[contenteditable="true"][aria-label*="mensaje" i], ' +
    'div[contenteditable="true"][aria-label*="message" i]';

  constructor(private readonly browser: BrowserService) {}

  /**
   * Send a direct message to a LinkedIn profile.
   * @param profileUrl full profile URL (https://www.linkedin.com/in/<slug>)
   */
  async sendMessage(profileUrl: string, message: string): Promise<SendResult> {
    const slug = profileUrl.match(/\/in\/([^/?#]+)/)?.[1];
    if (!slug) return { ok: false, message: `Cannot extract profile slug from ${profileUrl}` };

    const page = await this.browser.newPage();
    try {
      await page.goto(
        `https://www.linkedin.com/messaging/thread/new/?recipient=${slug}`,
        { waitUntil: 'domcontentloaded', timeout: 25000 },
      );
      await this.delay(3500, 4500);

      // ── 1. Compose box ────────────────────────────────────────────────────
      const compose = page.locator(MessengerService.COMPOSE_SELECTOR).first();
      const ready = await compose.waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
      if (!ready) {
        return { ok: false, message: 'Compose box did not load — not connected, or LinkedIn UI changed' };
      }

      // Recipient name, for logging and the response payload
      // The pill container also holds helper text ("Muestra sugerencias de
      // destinatarios…"), so keep only its first non-empty line.
      const recipient = await page
        .evaluate(() => {
          const pill = document.querySelector('[class*="recipient"], [class*="typeahead"] [class*="pill"]');
          const first = (pill?.textContent ?? '')
            .split('\n')
            .map((s) => s.trim())
            .find(Boolean);
          return first && first.length <= 80 ? first : null;
        })
        .catch(() => null);

      // ── 2. Type ───────────────────────────────────────────────────────────
      // keyboard.type fires real key/input events so React enables the send button.
      await compose.click();
      await this.delay(300, 500);
      await page.keyboard.type(message, { delay: 15 });
      await this.delay(600, 1000);

      // ── 3. Send ───────────────────────────────────────────────────────────
      const clicked = await page
        .evaluate(() => {
          const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter((b) => {
            const t = (b.textContent ?? '').trim().toLowerCase();
            return b.className.includes('msg-form__send') || t === 'enviar' || t === 'send';
          });
          const enabled = btns.find((b) => !b.disabled);
          if (enabled) { enabled.click(); return true; }
          return false;
        })
        .catch(() => false);

      if (!clicked) {
        await compose.click();
        await page.keyboard.press('Enter');
      }
      await this.delay(1500, 2200);

      // ── 4. Confirm it landed in the thread ────────────────────────────────
      const confirmed = await page
        .evaluate((snippet) => document.body.innerText.includes(snippet), message.slice(0, 25))
        .catch(() => false);

      const who = recipient ?? slug;
      if (!confirmed) {
        this.logger.warn(`Could not confirm message in thread for ${who}`);
        return { ok: false, message: `Sent but could not confirm delivery to ${who}`, recipient: who };
      }

      this.logger.log(`Message sent to ${who}`);
      return { ok: true, message: `Message sent to ${who}`, recipient: who };
    } finally {
      await page.close();
    }
  }

  private delay(min: number, max?: number) {
    const wait = max !== undefined ? min + Math.random() * (max - min) : min;
    return new Promise((r) => setTimeout(r, wait));
  }
}
