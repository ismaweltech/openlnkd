import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { chromium, Browser, BrowserContext, Page } from 'playwright';

@Injectable()
export class BrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserService.name);
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  async getContext(): Promise<BrowserContext> {
    if (!this.browser || !this.browser.isConnected()) {
      await this.launch();
    }
    return this.context!;
  }

  async newPage(): Promise<Page> {
    const ctx = await this.getContext();
    const page = await ctx.newPage();
    await this.applyStealthPatches(page);
    return page;
  }

  async setCookies(cookies: any[]) {
    const ctx = await this.getContext();
    await ctx.addCookies(cookies);
  }

  async getCookies() {
    const ctx = await this.getContext();
    return ctx.cookies();
  }

  async clearContext() {
    if (this.context) await this.context.close();
    this.context = await this.browser!.newContext(this.contextOptions());
  }

  private async launch() {
    const headless = process.env.HEADLESS !== 'false';
    this.logger.log(`Launching browser (headless=${headless})`);

    this.browser = await chromium.launch({
      headless,
      slowMo: Number(process.env.SLOW_MO ?? 50),
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    });

    this.context = await this.browser.newContext(this.contextOptions());
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
