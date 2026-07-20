import { Injectable, Logger } from '@nestjs/common';
import { BrowserService } from '../common/browser/browser.service';
import { DatabaseService } from '../common/database/database.service';
import { SessionService } from '../session/session.service';
import { VoyagerService } from '../common/voyager/voyager.service';
import { Job, JobSearchParams } from './jobs.types';
import { resolveGeoUrn } from '../common/location-urns';

const DATE_POSTED_FILTER: Record<string, string> = {
  past24h: 'r86400',
  pastWeek: 'r604800',
  pastMonth: 'r2592000',
};

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly browser: BrowserService,
    private readonly db: DatabaseService,
    private readonly session: SessionService,
    private readonly voyager: VoyagerService,
  ) {}

  async search(params: JobSearchParams): Promise<Job[]> {
    await this.session.ensureAuthenticated();
    const limit = params.limit ?? 25;

    // ── Primary: Voyager jobs/search API (no browser) ─────────────────────
    const apiJobs = await this.searchViaApi(params, limit);
    if (apiJobs.length > 0) {
      for (const job of apiJobs) await this.upsertJob(job);
      this.logger.log(`jobs/search API → ${apiJobs.length} jobs`);
      return apiJobs;
    }

    // ── Fallback: browser scraping ─────────────────────────────────────────
    this.logger.log(`API returned 0 results — falling back to browser`);
    return this.searchViaBrowser(params, limit);
  }

  // ── Voyager API search ─────────────────────────────────────────────────────

  private async searchViaApi(params: JobSearchParams, limit: number): Promise<Job[]> {
    // Build Restli query string
    const filters: string[] = [];
    if (params.remote) filters.push('workplaceType:List(2)');
    if (params.easyApply) filters.push('easyApply:List(true)');
    if (params.datePosted && DATE_POSTED_FILTER[params.datePosted]) {
      filters.push(`timePostedRange:List(${DATE_POSTED_FILTER[params.datePosted]})`);
    }

    let locationPart = '';
    if (params.geoId) {
      locationPart = `locationUnion:(geoId:${params.geoId})`;
    } else if (params.location) {
      const geoId = resolveGeoUrn(params.location);
      if (geoId) locationPart = `locationUnion:(geoId:${geoId})`;
    }

    const queryParts = [
      'origin:JOB_SEARCH_PAGE_OTHER_ENTRY',
      `keywords:${params.keywords}`,
      locationPart,
      filters.length > 0 ? `selectedFilters:(${filters.join(',')})` : '',
      'spellCorrectionEnabled:true',
    ].filter(Boolean);

    const query = `(${queryParts.join(',')})`;

    const jobs: Job[] = [];
    let start = 0;
    const pageSize = Math.min(limit, 25);

    while (jobs.length < limit) {
      const data = await this.voyager.get('jobs/search', {
        q: 'jserpFilters',
        query,
        decorationId: 'com.linkedin.voyager.deco.jserp.WebJobSearchHit-26',
        count: String(pageSize),
        start: String(start),
      });

      if (!data) { this.logger.debug('jobs/search API → null response'); break; }

      const byUrn = this.voyager.buildUrnMap(data);
      const elements: any[] = data?.data?.elements ?? data?.elements ?? [];
      this.logger.debug(`jobs/search API → ${elements.length} elements, ${data?.included?.length ?? 0} included`);
      if (elements.length === 0) break;

      for (const el of elements) {
        if (jobs.length >= limit) break;
        const job = this.parseJobHit(el, byUrn);
        if (job && !jobs.find((j) => j.id === job.id)) jobs.push(job);
      }

      start += elements.length;
      const total = data?.data?.paging?.total ?? data?.paging?.total ?? 0;
      if (start >= total || elements.length < pageSize) break;
    }

    return jobs;
  }

  private parseJobHit(el: any, byUrn: Map<string, any>): Job | null {
    // hitInfo key varies by LinkedIn version — look for whichever has jobPosting
    const hitInfo = el.hitInfo ?? {};
    const jserpData =
      hitInfo['com.linkedin.voyager.search.SearchJobJserp'] ??
      Object.values(hitInfo).find((v: any) => v?.jobPosting) as any;

    const jobUrn: string = jserpData?.jobPosting ?? '';
    if (!jobUrn) return null;

    const posting = byUrn.get(jobUrn);
    if (!posting) return null;

    const id = jobUrn.split(':').pop();
    if (!id) return null;

    // Company: resolve from included or from companyDetails directly
    const companyUrn: string = posting.companyDetails?.company ?? '';
    const companyEntity = companyUrn ? byUrn.get(companyUrn) : null;
    const company =
      companyEntity?.name ??
      posting.companyDetails?.companyResolutionResult?.name ??
      '';

    return {
      id,
      title: posting.title ?? '',
      company,
      location: posting.formattedLocation ?? null,
      remote: null,
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      posted_at: posting.listedAt ? new Date(posting.listedAt).toISOString() : null,
      description: null,
      easy_apply: !!(posting.easyApplyUrl ?? posting.applyMethod?.easyApplyUrl),
      applied: false,
      saved: false,
      scraped_at: new Date().toISOString(),
    };
  }

  // ── Browser fallback ───────────────────────────────────────────────────────

  private async searchViaBrowser(params: JobSearchParams, limit: number): Promise<Job[]> {
    const url = this.buildSearchUrl(params);
    this.logger.log(`Browser search: ${url}`);

    const page = await this.browser.newPage();
    const jobs: Job[] = [];

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this.delay(2000, 3000);

      let attempts = 0;
      while (jobs.length < limit && attempts < 10) {
        const cards = await page.$$(
          'div[data-job-id].job-card-container, li[data-occludable-job-id], [data-job-id]',
        );
        this.logger.debug(`Found ${cards.length} cards on page`);

        for (const card of cards) {
          if (jobs.length >= limit) break;
          try {
            const job = await this.extractJobCard(card, page);
            if (job && !jobs.find((j) => j.id === job.id)) {
              jobs.push(job);
              await this.upsertJob(job);
            }
          } catch { /* skip malformed card */ }
        }

        if (jobs.length >= limit) break;
        const hasNext = await this.scrollAndLoadMore(page);
        if (!hasNext) break;
        attempts++;
      }
    } finally {
      await page.close();
    }

    this.logger.log(`Browser scraped ${jobs.length} jobs`);
    return jobs;
  }

  async findAll(filters: {
    applied?: boolean;
    saved?: boolean;
    easyApply?: boolean;
    company?: string;
    keyword?: string;
    hasDescription?: boolean;
    notApplied?: boolean;
  } = {}): Promise<Job[]> {
    // Deduplicate by (title, company): keep the row with the most useful state
    // (applied > saved > most recently scraped). Uses window functions (SQLite ≥3.25).
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (filters.applied !== undefined) {
      where += ' AND applied = ?';
      params.push(filters.applied ? 1 : 0);
    }
    if (filters.saved !== undefined) {
      where += ' AND saved = ?';
      params.push(filters.saved ? 1 : 0);
    }
    if (filters.easyApply !== undefined) {
      where += ' AND easy_apply = ?';
      params.push(filters.easyApply ? 1 : 0);
    }
    if (filters.company) {
      where += ' AND company LIKE ?';
      params.push(`%${filters.company}%`);
    }
    if (filters.keyword) {
      where += ' AND (title LIKE ? OR description LIKE ?)';
      params.push(`%${filters.keyword}%`, `%${filters.keyword}%`);
    }
    if (filters.hasDescription !== undefined) {
      where += filters.hasDescription
        ? " AND description IS NOT NULL AND description != ''"
        : " AND (description IS NULL OR description = '')";
    }
    if (filters.notApplied) {
      where += ' AND applied = 0';
    }

    const query = `
      WITH ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY title, company
            ORDER BY
              applied DESC,
              saved DESC,
              scraped_at DESC
          ) AS rn
        FROM jobs
        ${where}
      )
      SELECT * FROM ranked WHERE rn = 1
      ORDER BY scraped_at DESC
    `;

    const rows = await this.db.query<any>(query, params);
    return rows.map(this.rowToJob);
  }

  async findOne(id: string): Promise<Job | null> {
    const row = await this.db.queryOne<any>('SELECT * FROM jobs WHERE id = ?', [id]);
    return row ? this.rowToJob(row) : null;
  }

  async markApplied(id: string): Promise<Job | null> {
    await this.db.execute('UPDATE jobs SET applied = 1 WHERE id = ?', [id]);
    return this.findOne(id);
  }

  async markSaved(id: string): Promise<Job | null> {
    await this.db.execute('UPDATE jobs SET saved = 1 WHERE id = ?', [id]);
    return this.findOne(id);
  }

  async getDescription(id: string): Promise<Job | null> {
    await this.session.ensureAuthenticated();
    const job = await this.findOne(id);
    if (!job) return null;
    if (job.description) return job;

    // ── Approach 1: direct Voyager API call (no browser, fast) ───────────
    // Even though LinkedIn's frontend now uses RSC, the Voyager REST endpoint
    // still accepts authenticated requests and returns clean JSON.
    let description = await this.fetchDescriptionViaApi(id);
    if (description) {
      await this.db.execute('UPDATE jobs SET description = ? WHERE id = ?', [description, id]);
      return this.findOne(id);
    }

    // ── Approach 2: browser — page.content() RSC scan + DOM ──────────────
    const page = await this.browser.newPage();
    try {
      // Intercept RSC component responses for description extraction
      const rscBodies: string[] = [];
      page.on('response', async (response: any) => {
        if (response.status() !== 200) return;
        const url: string = response.url();
        if (!url.includes('flagship-web/rsc-action')) return;
        try {
          const text = await response.text().catch(() => '');
          if (text) rscBodies.push(text);
        } catch { /* ignore */ }
      });

      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await this.delay(4000, 5000); // wait for RSC streaming

      // 2a: scan RSC bodies for description text
      for (const body of rscBodies) {
        const desc = this.extractDescriptionFromRscText(body);
        if (desc) {
          description = desc;
          this.logger.log(`[getDesc] RSC hit for job ${id} (${desc.length} chars)`);
          break;
        }
      }

      // 2b: scan the full page source (RSC flight data embedded in <script> tags)
      if (!description) {
        description = await page.evaluate(() => {
          // Look for description in embedded <script> RSC flight data
          for (const s of Array.from(document.querySelectorAll('script'))) {
            const t = s.textContent ?? '';
            if (!t.includes('description') || t.length < 200) continue;
            // Extract "text":"<long string>" patterns
            const re = /"text":"((?:[^"\\]|\\.){100,})"/g;
            let m: RegExpExecArray | null;
            let best = '';
            while ((m = re.exec(t)) !== null) {
              const v = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
              if (v.length > best.length) best = v;
            }
            if (best.length > 100) return best.substring(0, 8000);
          }
          return null;
        }).catch(() => null);
        if (description) this.logger.log(`[getDesc] page script RSC for job ${id} (${description.length} chars)`);
      }

      // 2c: JSON-LD structured data
      if (!description) {
        const jsonLdRaw = await page.evaluate(() => {
          for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
            const t = (s as HTMLElement).textContent ?? '';
            if (t.includes('description')) return t;
          }
          return null;
        }).catch(() => null);
        if (jsonLdRaw) {
          try {
            const jsonLd = JSON.parse(jsonLdRaw);
            const desc: string | undefined = jsonLd?.description;
            if (desc && desc.length > 50) {
              description = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 8000);
              this.logger.log(`[getDesc] JSON-LD for job ${id} (${description.length} chars)`);
            }
          } catch { /* ignore */ }
        }
      }

      // 2d: DOM selectors (classic LinkedIn classes, still present in some views)
      if (!description) {
        const showMoreBtn = await page.$(
          'button.show-more-less-html__button--more, [class*="show-more-less"] button, ' +
          'button[aria-label*="more" i], button[aria-label*="más" i]',
        ).catch(() => null);
        if (showMoreBtn) { await showMoreBtn.click().catch(() => null); await this.delay(600, 900); }

        description = await page.evaluate(() => {
          for (const sel of [
            '#job-details', '.jobs-description__content', '.jobs-description-content__text',
            '.description__text', '.show-more-less-html__markup',
            '[class*="jobs-description-content"]', '[class*="job-details-about"]',
          ]) {
            const el = document.querySelector(sel) as HTMLElement | null;
            const text = el?.innerText?.trim() ?? '';
            if (text.length > 80) return text.substring(0, 8000);
          }
          return null;
        });
        if (description) this.logger.log(`[getDesc] DOM for job ${id} (${description.length} chars)`);
      }

      if (description) {
        await this.db.execute('UPDATE jobs SET description = ? WHERE id = ?', [description, id]);
        return this.findOne(id);
      }

      this.logger.warn(
        `[getDesc] No description found for job ${id} ` +
        `(captured ${rscBodies.length} RSC ${rscBodies.length === 1 ? 'body' : 'bodies'}, none usable)`,
      );
    } finally {
      await page.close();
    }

    return job;
  }

  /**
   * Call LinkedIn's Voyager REST API directly with session cookies.
   * Faster than browser scraping and returns clean JSON.
   */
  private async fetchDescriptionViaApi(id: string): Promise<string | null> {
    for (const decorationId of [
      'com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-14',
      'com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-6',
    ]) {
      const data = await this.voyager.get(`jobs/jobPostings/${id}`, { decorationId });
      if (!data) continue;
      const desc = this.extractDescriptionFromApiResponse(data);
      if (desc) {
        this.logger.log(`[getDesc] Voyager API ✓ for job ${id} (${desc.length} chars)`);
        return desc;
      }
    }
    return null;
  }

  /**
   * Extract description from LinkedIn's RSC (React Server Components) wire format.
   * The RSC payload is not plain JSON — it's a streaming format where each line
   * starts with a numeric token, e.g.:
   *   0:{"data":{...}}
   *   1:["$","div",null,{...}]
   * The description appears as a JSON "text" string field within the payload.
   */
  private extractDescriptionFromRscText(rscText: string): string | null {
    const candidates: string[] = [];

    // ── Strategy A: "text":"<description>" pattern ────────────────────────
    // LinkedIn stores the description body in { "text": "..." } fields.
    // We regex-scan the whole payload for long "text" values.
    const textFieldRe = /"text":"((?:[^"\\]|\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = textFieldRe.exec(rscText)) !== null) {
      const raw = m[1];
      if (raw.length < 100) continue;
      // Unescape common JSON escapes
      const value = raw
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      candidates.push(value);
    }

    // ── Strategy B: try parsing each line as JSON and walk it ────────────
    for (const line of rscText.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1 || colonIdx > 4) continue; // only short numeric prefixes
      const payload = line.substring(colonIdx + 1).trim();
      if (!payload.startsWith('{') && !payload.startsWith('[')) continue;
      try {
        const obj = JSON.parse(payload);
        const desc = this.extractDescriptionFromApiResponse(obj);
        if (desc && desc.length > 100) candidates.push(desc);
      } catch { /* not valid JSON, skip */ }
    }

    // Return the longest candidate (most complete description)
    const best = candidates
      .filter((s) => s.length > 50)
      .sort((a, b) => b.length - a.length)[0] ?? null;

    return best ? best.substring(0, 8000) : null;
  }

  /**
   * Walk a LinkedIn API response recursively to find job description text.
   * Handles both Voyager REST (`data.description.text`) and GraphQL shapes.
   */
  private extractDescriptionFromApiResponse(data: any): string | null {
    const candidates: string[] = [];

    const walk = (obj: any, depth = 0) => {
      if (depth > 10 || !obj || typeof obj !== 'object') return;

      // Most common Voyager REST shape: { description: { text: "..." } }
      if (typeof obj?.description?.text === 'string') {
        candidates.push(obj.description.text);
      }
      // Some shapes expose it directly
      if (typeof obj?.descriptionText === 'string') candidates.push(obj.descriptionText);
      if (typeof obj?.jobDescription === 'string') candidates.push(obj.jobDescription);
      // HTML variant
      if (typeof obj?.description?.html === 'string') {
        // Strip tags for plain text
        candidates.push(obj.description.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      }

      for (const val of Object.values(obj)) {
        walk(val, depth + 1);
      }
    };

    walk(data);

    // Return the longest candidate (most complete description)
    const best = candidates
      .filter((s) => s.length > 50)
      .sort((a, b) => b.length - a.length)[0] ?? null;

    return best ? best.substring(0, 8000) : null;
  }

  private buildSearchUrl(params: JobSearchParams): string {
    const base = 'https://www.linkedin.com/jobs/search/';
    const p = new URLSearchParams();

    p.set('keywords', params.keywords);
    if (params.geoId) {
      // Explicit geoId from LinkedIn typeahead — most precise, use directly
      p.set('geoId', params.geoId);
    } else if (params.location) {
      const geoId = resolveGeoUrn(params.location);
      if (geoId) {
        // Use geoId ONLY — sending both confuses LinkedIn's autocomplete
        p.set('geoId', geoId);
      } else {
        // Unknown location: fall back to text param
        p.set('location', params.location);
      }
    }
    if (params.remote) p.set('f_WT', '2');
    if (params.easyApply) p.set('f_LF', 'f_AL');
    if (params.datePosted) p.set('f_TPR', DATE_POSTED_FILTER[params.datePosted]);

    return `${base}?${p.toString()}`;
  }

  private async extractJobCard(card: any, _page: any): Promise<Job | null> {
    // ElementHandle: usar card.$() en vez de card.locator()
    const id = await card.getAttribute('data-job-id').catch(() => null);
    if (!id) return null;

    const getText = async (selectors: string[]): Promise<string> => {
      for (const sel of selectors) {
        try {
          const el = await card.$(sel);
          if (el) {
            const txt = await el.textContent();
            if (txt?.trim()) return txt.trim();
          }
        } catch { /* skip */ }
      }
      return '';
    };

    const getAttr = async (selectors: string[], attr: string): Promise<string | null> => {
      for (const sel of selectors) {
        try {
          const el = await card.$(sel);
          if (el) {
            const val = await el.getAttribute(attr);
            if (val) return val;
          }
        } catch { /* skip */ }
      }
      return null;
    };

    const title = await getText([
      '[class*="job-card-list__title"]',
      '.job-card-container__link',
      'a[class*="job-card"]',
      'strong',
    ]);

    const company = await getText([
      '.artdeco-entity-lockup__subtitle',
      '.job-card-container__company-name',
      '[class*="company-name"]',
    ]);

    const location = await getText([
      '.artdeco-entity-lockup__caption',
      '.job-card-container__metadata-item',
      '[class*="metadata-item"]',
    ]);

    const footerText = await getText([
      '.job-card-list__footer-wrapper',
      '[class*="footer-wrapper"]',
    ]);

    const postedAt = await getAttr(['time'], 'datetime');

    const easyApply =
      footerText.toLowerCase().includes('easy apply') ||
      footerText.toLowerCase().includes('solicitud sencilla');

    return {
      id: String(id),
      title,
      company,
      location: location || null,
      remote: null,
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      posted_at: postedAt,
      description: null,
      easy_apply: easyApply,
      applied: false,
      saved: false,
      scraped_at: new Date().toISOString(),
    };
  }

  private async scrollAndLoadMore(page: any): Promise<boolean> {
    // LinkedIn jobs sidebar is a scrollable div, not the body
    await page.evaluate(() => {
      const list = document.querySelector(
        '.jobs-search__results-list, ' +
        '.scaffold-layout__list, ' +
        '[class*="jobs-search-results-list"], ' +
        'ul[class*="jobs-search"]',
      );
      if (list) {
        list.scrollBy(0, 800);
      } else {
        window.scrollBy(0, 800);
      }
    });
    await this.delay(2000, 3000);
    return true; // keep looping until attempts limit or job limit
  }

  private async upsertJob(job: Job): Promise<void> {
    await this.db.execute(
      `INSERT INTO jobs
        (id, title, company, location, remote, url, posted_at, description, easy_apply, applied, saved, scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [
        job.id, job.title, job.company, job.location, job.remote,
        job.url, job.posted_at, job.description,
        job.easy_apply ? 1 : 0, 0, 0, job.scraped_at,
      ],
    );
  }

  private rowToJob(row: any): Job {
    return {
      ...row,
      easy_apply: Boolean(row.easy_apply),
      applied: Boolean(row.applied),
      saved: Boolean(row.saved),
    };
  }

  private delay(min: number, max: number) {
    return new Promise((r) => setTimeout(r, Math.random() * (max - min) + min));
  }
}
