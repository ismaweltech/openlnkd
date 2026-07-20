import { Injectable, Logger } from '@nestjs/common';
import { BrowserService } from '../common/browser/browser.service';
import { DatabaseService } from '../common/database/database.service';
import { SessionService } from '../session/session.service';
import { VoyagerService } from '../common/voyager/voyager.service';

export interface LocationSuggestion {
  id: string;
  label: string;
}

@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);

  constructor(
    private readonly session: SessionService,
    private readonly browser: BrowserService,
    private readonly db: DatabaseService,
    private readonly voyager: VoyagerService,
  ) {}

  async typeahead(query: string): Promise<LocationSuggestion[]> {
    if (!query || query.trim().length < 2) return [];

    const key = query.trim().toLowerCase();
    const keyNorm = this.normalize(key);

    // ── 1. DB cache (accent-insensitive) — skip browser if ≥3 hits ────────
    const cached = await this.db.query<{ geo_id: string; label: string }>(
      `SELECT DISTINCT geo_id, label
       FROM location_cache
       WHERE label_normalized LIKE ?
       ORDER BY
         CASE WHEN label_normalized LIKE ? THEN 0 ELSE 1 END,
         label ASC`,
      [`%${keyNorm}%`, `${keyNorm}%`],
    );

    if (cached.length >= 3) {
      this.logger.debug(`DB hit for "${key}" (${cached.length} results)`);
      return cached.map((r) => ({ id: r.geo_id, label: r.label }));
    }

    // ── 2. Direct Voyager API (no browser) ──────────────────────────────────
    await this.session.ensureAuthenticated();
    this.logger.log(`DB has ${cached.length} results for "${key}" (<3) — calling Voyager API`);

    const results = await this.fetchTypeaheadFromApi(query.trim());

    if (results.length > 0) {
      await this.cacheResults(key, results);
      return results;
    }

    // ── 3. Browser fallback (intercept LinkedIn typeahead XHR) ──────────────
    this.logger.log(`Voyager API returned 0 results for "${key}" — opening browser`);
    return this.typeaheadViaBrowser(query.trim(), key);
  }

  // ── Voyager API ────────────────────────────────────────────────────────────

  private async fetchTypeaheadFromApi(query: string): Promise<LocationSuggestion[]> {
    const results: LocationSuggestion[] = [];

    // Shape A: hitsV2 — stable older endpoint, returns GEO type hits
    const data = await this.voyager.get('typeahead/hitsV2', {
      keywords: query,
      q: 'type',
      type: 'GEO',
      origin: 'OTHER',
      count: '10',
    });

    if (data) this.parseTypeaheadResponse(data, results);
    if (results.length > 0) return results;

    // Shape B: job location suggest endpoint
    const data2 = await this.voyager.get('jobs/jobsDashLocationSuggest', {
      q: 'locationSuggest',
      query,
    });
    if (data2) this.parseTypeaheadResponse(data2, results);

    return results;
  }

  // ── Browser fallback ───────────────────────────────────────────────────────

  private async typeaheadViaBrowser(query: string, key: string): Promise<LocationSuggestion[]> {
    const page = await this.browser.newPage();
    const results: LocationSuggestion[] = [];

    try {
      page.on('response', async (response: any) => {
        const url: string = response.url();
        if (response.status() !== 200) return;
        if (!url.includes('typeaheadFilterQuery') && !url.includes('LocationSuggest')) return;
        try {
          const text = await response.text().catch(() => '');
          const body = JSON.parse(text);
          this.parseTypeaheadResponse(body, results);
        } catch { /* ignore */ }
      });

      await page.goto('https://www.linkedin.com/jobs/search/', {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await this.delay(2000);

      const locationSelectors = [
        'input[id*="jobs-search-box-location"]',
        'input[aria-label*="City, state"]',
        'input[aria-label*="Ciudad"]',
        'input[aria-label*="Ubicación"]',
        'input[aria-label*="Location"]',
        '.jobs-search-box input[type="text"]:last-of-type',
      ];

      let locationInput: any = null;
      for (const sel of locationSelectors) {
        locationInput = await page.$(sel).catch(() => null);
        if (locationInput) break;
      }

      if (!locationInput) {
        this.logger.warn('Location input not found on jobs search page');
        return [];
      }

      await locationInput.click({ clickCount: 3 });
      await locationInput.type(query, { delay: 80 });
      await this.delay(3000);
    } catch (err: any) {
      this.logger.error(`Typeahead browser scrape failed: ${err.message}`);
    } finally {
      await page.close();
    }

    if (results.length > 0) {
      await this.cacheResults(key, results);
    }

    this.logger.log(`Typeahead browser "${key}" → ${results.length} results`);
    return results;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private parseTypeaheadResponse(data: any, out: LocationSuggestion[]) {
    const inner = data?.data?.data ?? data?.data ?? data;

    // ── Shape A: searchDashReusableTypeaheadByType (GraphQL typing suggestions) ──
    const typeahead = inner?.searchDashReusableTypeaheadByType;
    if (typeahead?.elements) {
      for (const e of typeahead.elements) {
        const urn: string = e?.trackingUrn ?? '';
        const id = urn.split(':').pop() ?? '';
        const label: string = e?.title?.text ?? e?.title?.textDirectional ?? e?.headline?.text ?? '';
        if (id && label && !out.find((r) => r.id === id)) out.push({ id, label });
      }
      return;
    }

    // ── Shape B: jobsDashLocationSuggestionsByLocationSuggestions (recent) ────
    const recent = inner?.jobsDashLocationSuggestionsByLocationSuggestions;
    if (recent?.elements) {
      for (const group of recent.elements) {
        for (const s of group?.locationSuggestions ?? []) {
          const urn: string = s?.['*geoLocation'] ?? '';
          const id = urn.split(':').pop() ?? '';
          const label: string = s?.displayName ?? s?.name ?? '';
          if (id && label && !out.find((r) => r.id === id)) out.push({ id, label });
        }
      }
      return;
    }

    // ── Shape C: hitsV2 (typeahead/hitsV2 endpoint) ───────────────────────────
    const hits = inner?.elements ?? inner?.hits ?? inner?.data?.elements;
    if (Array.isArray(hits) && hits.length > 0 && (hits[0]?.type === 'GEO' || hits[0]?.objectUrn)) {
      for (const hit of hits) {
        const urn: string = hit?.objectUrn ?? hit?.hitInfo?.geoUrn ?? '';
        const id = urn.split(':').pop() ?? '';
        const label: string =
          hit?.text?.text ??
          hit?.hitInfo?.['com.linkedin.typeahead.ComTypeaheadGeoHitInfo']?.name ??
          hit?.header?.text ??
          '';
        if (id && label && !out.find((r) => r.id === id)) out.push({ id, label });
      }
    }
  }

  private async cacheResults(key: string, results: LocationSuggestion[]): Promise<void> {
    this.logger.log(`Caching ${results.length} results for "${key}"`);
    for (const r of results) {
      await this.db.execute(
        `INSERT INTO location_cache (query, geo_id, label, label_normalized)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (query, geo_id) DO UPDATE SET
           label_normalized = EXCLUDED.label_normalized`,
        [key, r.id, r.label, this.normalize(r.label)],
      ).catch(() => {});
    }
  }

  /** Strip accents and lowercase — "Alcalá de Henares" → "alcala de henares" */
  private normalize(str: string): string {
    return str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
  }

  /** One-time backfill: populate label_normalized for rows inserted before this column existed */
  async backfillNormalized(): Promise<void> {
    const rows = await this.db.query<{ query: string; geo_id: string; label: string }>(
      `SELECT query, geo_id, label FROM location_cache WHERE label_normalized IS NULL`,
    );
    if (rows.length === 0) return;
    this.logger.log(`Backfilling label_normalized for ${rows.length} cached locations`);
    for (const row of rows) {
      await this.db.execute(
        `UPDATE location_cache SET label_normalized = ? WHERE query = ? AND geo_id = ?`,
        [this.normalize(row.label), row.query, row.geo_id],
      ).catch(() => {});
    }
    this.logger.log('Backfill done');
  }

  private delay(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
