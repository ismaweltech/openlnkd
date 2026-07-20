import { Injectable, Logger } from '@nestjs/common';
import { SessionService } from '../../session/session.service';

/**
 * Thin authenticated HTTP client for LinkedIn's Voyager REST API.
 * Uses the session cookies stored in the DB — no browser needed.
 *
 * Response format: application/vnd.linkedin.normalized+json+2.1
 *   { data: {...}, included: [...] }
 * The `included` array contains the actual entities; `data` holds references.
 */
@Injectable()
export class VoyagerService {
  private readonly BASE = 'https://www.linkedin.com/voyager/api';
  private readonly logger = new Logger(VoyagerService.name);

  constructor(private readonly session: SessionService) {}

  /** GET /voyager/api/{path}?{params} — returns parsed JSON or null on error */
  async get<T = any>(path: string, params?: Record<string, string>): Promise<T | null> {
    const cookies = await this.session.getRawCookies();
    if (!cookies.length) return null;

    const cookieStr = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
    const csrf = cookies.find((c: any) => c.name === 'JSESSIONID')?.value?.replace(/^"|"$/g, '') ?? '';

    const url = new URL(`${this.BASE}/${path.replace(/^\//, '')}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    try {
      const resp = await (globalThis.fetch as typeof fetch)(url.toString(), {
        headers: this.buildHeaders(cookieStr, csrf),
      });

      if (!resp.ok) {
        // 5xx = unexpected server error → warn; 4xx = endpoint likely deprecated → debug
        const log = resp.status >= 500 ? this.logger.warn.bind(this.logger) : this.logger.debug.bind(this.logger);
        log(`GET /${path} → HTTP ${resp.status}`);
        return null;
      }

      return resp.json() as Promise<T>;
    } catch (err: any) {
      this.logger.debug(`GET /${path} error: ${err.message}`);
      return null;
    }
  }

  /** POST /voyager/api/{path} — sends JSON body, returns parsed JSON or null on error */
  async post<T = any>(path: string, body: unknown, params?: Record<string, string>): Promise<T | null> {
    const cookies = await this.session.getRawCookies();
    if (!cookies.length) return null;

    const cookieStr = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
    const csrf = cookies.find((c: any) => c.name === 'JSESSIONID')?.value?.replace(/^"|"$/g, '') ?? '';

    const url = new URL(`${this.BASE}/${path.replace(/^\//, '')}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }

    try {
      const resp = await (globalThis.fetch as typeof fetch)(url.toString(), {
        method: 'POST',
        headers: { ...this.buildHeaders(cookieStr, csrf), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        this.logger.debug(`POST /${path} → HTTP ${resp.status}`);
        return null;
      }

      const text = await resp.text();
      return text ? JSON.parse(text) as T : null as T;
    } catch (err: any) {
      this.logger.debug(`POST /${path} error: ${err.message}`);
      return null;
    }
  }

  /** Build a Map<urn, entity> from the `included` array for fast lookups */
  buildUrnMap(data: any): Map<string, any> {
    const map = new Map<string, any>();
    for (const e of data?.included ?? []) {
      if (e?.entityUrn) map.set(e.entityUrn, e);
    }
    return map;
  }

  buildHeaders(cookieStr: string, csrf: string): Record<string, string> {
    return {
      Cookie: cookieStr,
      'Csrf-Token': csrf,
      Accept: 'application/vnd.linkedin.normalized+json+2.1',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Li-Lang': 'es_ES',
      'X-Li-Track':
        '{"clientVersion":"1.13.2057","mpVersion":"1.13.2057","osName":"web","timezoneOffset":2,"timezone":"Europe/Madrid","deviceFormFactor":"DESKTOP","mpName":"voyager-web"}',
      'X-Restli-Protocol-Version': '2.0.0',
      Referer: 'https://www.linkedin.com/',
    };
  }
}
