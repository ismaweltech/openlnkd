import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { BrowserService } from '../common/browser/browser.service';
import { DatabaseService } from '../common/database/database.service';

const LINKEDIN_HOME = 'https://www.linkedin.com';
const FEED_URL = 'https://www.linkedin.com/feed/';

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private authenticated = false;

  constructor(
    private readonly browser: BrowserService,
    private readonly db: DatabaseService,
  ) {}

  async isAuthenticated(): Promise<boolean> {
    if (this.authenticated) return true;
    return this.tryRestoreSession();
  }

  async login(email?: string, password?: string): Promise<{ ok: boolean; message: string }> {
    const _email = email ?? process.env.LINKEDIN_EMAIL;
    const _password = password ?? process.env.LINKEDIN_PASSWORD;

    if (!_email || !_password) {
      throw new UnauthorizedException('LinkedIn credentials not configured');
    }

    const restored = await this.tryRestoreSession();
    if (restored) {
      this.logger.log('Session restored from DB');
      return { ok: true, message: 'Session restored from saved cookies' };
    }

    this.logger.log('Starting fresh login...');
    const page = await this.browser.newPage();

    try {
      await page.goto(`${LINKEDIN_HOME}/login`, { waitUntil: 'domcontentloaded' });
      await this.humanDelay(1200, 1800);

      // LinkedIn renders two forms (one hidden) — target only the visible one
      const emailInput = page.locator('input[type="email"]:visible').last();
      await emailInput.waitFor({ state: 'visible', timeout: 15000 });
      await emailInput.click();
      await this.humanDelay(300, 500);
      await emailInput.type(_email, { delay: 40 });

      await this.humanDelay(400, 700);

      const passwordInput = page.locator('input[type="password"]:visible').last();
      await passwordInput.click();
      await this.humanDelay(200, 400);
      await passwordInput.type(_password, { delay: 40 });

      await this.humanDelay(500, 900);
      await page.keyboard.press('Enter');

      await page.waitForURL(/linkedin\.com\/(feed|check\/manage-account)/, { timeout: 20000 });

      if (page.url().includes('check/manage-account')) {
        return { ok: false, message: 'LinkedIn requires verification. Check your email/phone.' };
      }

      await this.saveSession();
      this.authenticated = true;
      this.logger.log('Login successful');
      return { ok: true, message: 'Logged in successfully' };
    } finally {
      await page.close();
    }
  }

  async logout() {
    this.authenticated = false;
    await this.db.execute('DELETE FROM session WHERE id = 1');
    await this.browser.clearContext();
    this.logger.log('Session cleared');
  }

  async ensureAuthenticated() {
    if (!(await this.isAuthenticated())) {
      await this.login();
    }
  }

  /** Returns raw cookies from DB — use for direct HTTP requests to LinkedIn */
  async getRawCookies(): Promise<Array<{ name: string; value: string; domain: string }>> {
    const row = await this.db.queryOne<{ cookies: string }>('SELECT cookies FROM session WHERE id = 1');
    if (!row?.cookies) return [];
    try { return JSON.parse(row.cookies); } catch { return []; }
  }

  private async tryRestoreSession(): Promise<boolean> {
    const row = await this.db.queryOne<{ cookies: string }>('SELECT cookies FROM session WHERE id = 1');
    if (!row) return false;

    let cookies: any[];
    try { cookies = JSON.parse(row.cookies); } catch { return false; }

    // ── Fast path: validate via /voyager/api/me (no browser needed) ───────
    try {
      const cookieStr = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
      const csrf = cookies.find((c: any) => c.name === 'JSESSIONID')?.value?.replace(/^"|"$/g, '') ?? '';

      const resp = await (globalThis.fetch as typeof fetch)(
        'https://www.linkedin.com/voyager/api/me',
        {
          headers: {
            Cookie: cookieStr,
            'Csrf-Token': csrf,
            Accept: 'application/vnd.linkedin.normalized+json+2.1',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'X-Requested-With': 'XMLHttpRequest',
          },
        },
      );

      if (resp.ok) {
        // Session valid — load cookies into browser context (needed for write ops)
        await this.browser.setCookies(cookies);
        this.authenticated = true;
        this.logger.log('Session validated via API (no browser needed)');
        return true;
      }

      this.logger.warn(`Session API check returned ${resp.status} — trying browser fallback`);
      // fall through to browser-based validation (handles account picker, 2FA, etc.)
    } catch (err: any) {
      // Network / fetch error — fall back to browser-based validation
      this.logger.warn(`Session API check failed (${err.message}), falling back to browser`);
    }

    // ── Fallback: open browser to /feed ───────────────────────────────────
    try {
      await this.browser.setCookies(cookies);
      const page = await this.browser.newPage();
      await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });

      // Handle LinkedIn account picker ("¡Hola de nuevo!" / "Welcome back!")
      // When session cookies exist but LinkedIn shows the account chooser at
      // /uas/login?session_redirect=..., we click the first account card to
      // complete sign-in. Uses page.evaluate for maximum DOM flexibility.
      if (!page.url().includes('/feed')) {
        this.logger.debug(`Redirected to ${page.url()} — checking for account picker`);
        try {
          // Wait for the page content to be interactive
          await page.waitForLoadState('domcontentloaded');

          const strategy = await page.evaluate((): string | null => {
            const SKIP = ['otra cuenta', 'another account', 'unirse', 'join now'];
            const skip = (t: string) => SKIP.some(w => t.toLowerCase().includes(w));
            const bodyText = document.body?.textContent ?? '';

            // Guard: if there's a standard login form (email input) and NO masked-email
            // pattern (h*****@gmail.com), this is the plain login page — don't touch it.
            const hasMaskedEmail = /[a-z\d]\*+@[a-z\d]/.test(bodyText);
            const hasEmailInput  = !!document.querySelector('input[type="email"], input[name="session_key"]');
            if (!hasMaskedEmail && hasEmailInput) return null; // standard login, not account picker

            // Strategy 1: find the container <ul>/<ol> that has "otra cuenta" in it,
            // then click the first <li> that is NOT that option.
            // This avoids clicking nav/footer <li> elements.
            for (const list of Array.from(document.querySelectorAll('ul, ol'))) {
              if (!skip(list.textContent ?? '')) continue;
              for (const li of Array.from(list.querySelectorAll(':scope > li'))) {
                if (skip(li.textContent ?? '')) continue;
                if ((li.textContent ?? '').trim().length < 3) continue;
                const clickable = li.querySelector('a, button') as HTMLElement | null;
                if (clickable) { clickable.click(); return 'ul-picker'; }
                // Some pickers make the <li> itself clickable
                if ((li as HTMLElement).onclick || li.getAttribute('role') === 'button') {
                  (li as HTMLElement).click(); return 'li-direct';
                }
              }
            }

            // Strategy 2: find element containing a masked email (e.g. h*****@gmail.com)
            // and walk up to its nearest clickable ancestor.
            if (hasMaskedEmail) {
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              let node;
              while ((node = walker.nextNode())) {
                if (!/[a-z\d]\*+@[a-z\d]/.test(node.textContent ?? '')) continue;
                let el: Element | null = (node as Text).parentElement;
                while (el && !['A', 'BUTTON'].includes(el.tagName)) el = el.parentElement;
                if (el) { (el as HTMLElement).click(); return 'masked-email'; }
                break;
              }
            }

            // Strategy 3: anchor with loginSubmitSource in href (form submit link)
            const submitLink = document.querySelector(
              'a[href*="loginSubmitSource"], a[href*="login-submit"]',
            ) as HTMLElement | null;
            if (submitLink && !skip(submitLink.textContent ?? '')) {
              submitLink.click(); return 'submit-link';
            }

            return null;
          });

          if (strategy) {
            this.logger.debug(`Account picker clicked via strategy: ${strategy}`);
            // Wait for LinkedIn to navigate — could be /feed (valid session)
            // or back to /uas/login (session expired → password required)
            try {
              await page.waitForURL(
                /linkedin\.com\/(feed|mynetwork|jobs|uas\/login\?.*password)/,
                { timeout: 12000 },
              );
            } catch {
              // waitForURL timeout — check current URL anyway
            }

            // If session expired, LinkedIn shows a password form after clicking the account
            const afterUrl = page.url();
            if (!afterUrl.includes('/feed') && !afterUrl.includes('/mynetwork') && !afterUrl.includes('/jobs')) {
              const pwInput = page.locator('#session_password, input[type="password"]').first();
              if (await pwInput.isVisible({ timeout: 3000 }).catch(() => false)) {
                this.logger.debug('Account picker → password form (session expired); re-authenticating');
                const pw = process.env.LINKEDIN_PASSWORD ?? '';
                if (pw) {
                  await pwInput.fill(pw);
                  await page.keyboard.press('Enter');
                  await page.waitForURL(/linkedin\.com\/(feed|mynetwork|jobs)/, { timeout: 15000 });
                  await this.saveSession();
                }
              }
            }
          } else {
            const title = await page.title();
            // Log a snippet of the page body to help identify the page structure
            const bodySnippet = await page.evaluate(() =>
              (document.body?.innerText ?? '').slice(0, 300).replace(/\s+/g, ' '),
            ).catch(() => '');
            this.logger.debug(`No account picker found — title: "${title}" | body: ${bodySnippet}`);
          }
        } catch (pickerErr: any) {
          this.logger.debug(`Account picker handling: ${pickerErr.message}`);
        }
      }

      const isLoggedIn = page.url().includes('/feed');
      if (isLoggedIn) await this.saveSession(); // refresh stored cookies after picker interaction
      await page.close();

      if (isLoggedIn) {
        this.authenticated = true;
        this.logger.log('Session restored via browser');
        return true;
      }
    } catch (err: any) {
      this.logger.warn(`Failed to restore session: ${err?.message ?? err}`);
    }

    return false;
  }

  private async saveSession() {
    const cookies = await this.browser.getCookies();
    await this.db.execute(
      'INSERT INTO session (id, cookies, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP) ON CONFLICT (id) DO UPDATE SET cookies = EXCLUDED.cookies, updated_at = CURRENT_TIMESTAMP',
      [JSON.stringify(cookies)],
    );
  }

  private humanDelay(min: number, max: number): Promise<void> {
    const ms = Math.floor(Math.random() * (max - min) + min);
    return new Promise((r) => setTimeout(r, ms));
  }
}
