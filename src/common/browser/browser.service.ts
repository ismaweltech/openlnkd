import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { chromium, Browser, BrowserContext, Page } from 'playwright';

@Injectable()
export class BrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserService.name);
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  /**
   * Last session cookies handed to us. If Chromium crashes or disconnects,
   * getContext() relaunches it — and without this, the new context would come up
   * logged out while SessionService still believes it's authenticated, so every
   * page would silently load as an anonymous visitor.
   */
  private sessionCookies: any[] | null = null;

  async getContext(): Promise<BrowserContext> {
    if (!this.browser || !this.browser.isConnected()) {
      await this.launch();
    } else if (!this.context) {
      await this.createContext();
    }
    return this.context!;
  }

  private async createContext() {
    this.context = await this.browser!.newContext(this.contextOptions());
    if (this.sessionCookies?.length) {
      await this.context.addCookies(this.sessionCookies);
      this.logger.log('Session cookies applied to new browser context');
    }
  }

  async newPage(): Promise<Page> {
    const ctx = await this.getContext();
    let page: Page;
    try {
      page = await ctx.newPage();
    } catch {
      // Context closed under us (browser crash): relaunch once and retry.
      this.context = null;
      page = await (await this.getContext()).newPage();
    }
    await this.applyStealthPatches(page);
    return page;
  }

  async setCookies(cookies: any[]) {
    this.sessionCookies = cookies;
    const ctx = await this.getContext();
    await ctx.addCookies(cookies);
  }

  async getCookies() {
    const ctx = await this.getContext();
    return ctx.cookies();
  }

  /** Logout: drop the session for good (cookies are NOT restored afterwards). */
  async clearContext() {
    this.sessionCookies = null;
    if (this.context) await this.context.close();
    this.context = await this.browser!.newContext(this.contextOptions());
  }

  private async launch() {
    const headless = process.env.HEADLESS !== 'false';
    this.logger.log(`Launching browser (headless=${headless})`);
    // A disconnected browser may still hold a process — make sure it's gone.
    await this.browser?.close().catch(() => {});

    this.browser = await chromium.launch({
      headless,
      slowMo: Number(process.env.SLOW_MO ?? 50),
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    });

    await this.createContext();
  }

  private contextOptions() {
    return {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'Europe/Madrid',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };
  }

  private async applyStealthPatches(page: Page) {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    });
  }

  async onModuleDestroy() {
    if (this.browser) await this.browser.close();
  }
}
