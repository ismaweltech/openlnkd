import { Injectable, Logger } from '@nestjs/common';
import { BrowserService } from '../common/browser/browser.service';
import { DatabaseService } from '../common/database/database.service';
import { SessionService } from '../session/session.service';
import { VoyagerService } from '../common/voyager/voyager.service';
import { resolveGeoUrn } from '../common/location-urns';

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

  async typeahead(query: string, fresh = false): Promise<LocationSuggestion[]> {
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

    if (cached.length >= 3 && !fresh) {
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

  /**
   * geoId for a free-text location in people and job search. People search only
   * accepts metro/region geos: since Oct 2026 a city geo ("Sevilla, Andalucía,
   * España") returns "no results" while the metro one ("Sevilla y alrededores")
   * works; jobs take either, so both use the metro. Falls back to the static map.
   */
  async resolveSearchGeo(location: string): Promise<string | undefined> {
    const norm = (x: string) => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const q = norm(location);
    try {
      const results = await this.typeahead(location);
      const metro = results.find((r) => {
        const l = norm(r.label);
        return [`${q} y alrededores`, `greater ${q} area`, `${q} metropolitan area`, `area metropolitana de ${q}`].includes(l);
      });
      if (metro) {
        this.logger.debug(`Search geo "${location}" → metro ${metro.label} (${metro.id})`);
        return metro.id;
      }
      // Regions ("Andalucía" → "Andalucía, España"): exact first segment + a country.
      const country = norm(process.env.OPENLNKD_LOCATION_COUNTRY ?? 'España');
      const region = results.find((r) => {
        const parts = r.label.split(',').map(norm);
        return parts.length === 2 && parts[0] === q && [country, 'spain'].includes(parts[1]);
      });
      if (region) {
        this.logger.debug(`Search geo "${location}" → region ${region.label} (${region.id})`);
        return region.id;
      }
    } catch { /* fall back to the static map */ }
    return resolveGeoUrn(location);
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

  /**
   * LinkedIn retired the typeahead APIs and the jobs page no longer has a location
   * box (it's a single "describe the job" field since 2026-11). The people-search
   * "Ubicaciones" filter still suggests places: it answers with an RSC payload
   * (FiltersLocationTypeaheadRequest) where every option carries its geo id.
   */
  private async typeaheadViaBrowser(query: string, key: string): Promise<LocationSuggestion[]> {
    const page = await this.browser.newPage();
    const answers: LocationSuggestion[][] = [];
    let results: LocationSuggestion[] = [];

    try {
      page.on('response', async (response: any) => {
        if (response.status() !== 200 || !response.url().includes('FiltersLocationTypeahead')) return;
        const text = await response.text().catch(() => '');
        const parsed = this.parseLocationFilterResponse(text);
        if (parsed.length) answers.push(parsed);
      });

      await page.goto('https://www.linkedin.com/search/results/people/?keywords=a', {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await page.getByText(/^(Ubicaciones|Locations)$/).first().click({ timeout: 15000 });
      const input = page.locator('input[placeholder*="ubicaci" i], input[placeholder*="location" i]').first();
      await input.waitFor({ state: 'visible', timeout: 10000 });
      await input.click();

      // Focusing the box returns a default list (Australia, Estados Unidos…) that can
      // arrive after our query's answer; only accept an answer that mentions the query.
      const q = this.normalize(query).split(/[\s,]+/)[0];
      const matching = () => answers.filter((a) => a.some((r) => this.normalize(r.label).includes(q))).at(-1);
      for (let attempt = 0; attempt < 2 && !matching(); attempt++) {
        // fill() sends the whole query at once, so we don't collect answers for "B", "Bi"…
        await input.fill('');
        await input.fill(query);
        for (let waited = 0; waited < 10000 && !matching(); waited += 300) await this.delay(300);
      }
      await this.delay(600); // a later answer for the full text may still be on its way
      results = matching() ?? [];
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

  /** Each option: FILTER_ITEM_geoUrn_<id>_CHECKED …  then its label as the first text child. */
  private parseLocationFilterResponse(text: string): LocationSuggestion[] {
    const out: LocationSuggestion[] = [];
    const rx = /FILTER_ITEM_geoUrn_(\d+)_CHECKED"\}\}\},"location":"center"[\s\S]*?"children":\["((?:[^"\\]|\\.)+)"\]/g;
    for (const m of text.matchAll(rx)) {
      let label = m[2];
      try { label = JSON.parse(`"${m[2]}"`); } catch { /* keep raw */ }
      if (!out.find((r) => r.id === m[1])) out.push({ id: m[1], label });
    }
    return out;
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
