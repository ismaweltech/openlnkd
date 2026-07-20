import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BrowserService } from '../common/browser/browser.service';
import { DatabaseService } from '../common/database/database.service';
import { SessionService } from '../session/session.service';
import { VoyagerService } from '../common/voyager/voyager.service';
import { LocationsService } from '../locations/locations.service';
import { SearchCompaniesDto, SearchPeopleAtCompanyDto } from './dto/search-companies.dto';
import type { Person } from '../people/people.service';

export interface Company {
  id: string;
  /** Numeric LinkedIn company ID (e.g. "1441") — used for currentCompany people search */
  linkedin_id: string | null;
  name: string;
  url: string | null;
  industry: string | null;
  size: string | null;
  headline: string | null;
  location: string | null;
  follower_count: string | null;
  company_type: string | null;
  scraped_at: string;
}

@Injectable()
export class CompaniesService {
  private readonly logger = new Logger(CompaniesService.name);

  constructor(
    private readonly browser: BrowserService,
    private readonly db: DatabaseService,
    private readonly session: SessionService,
    private readonly voyager: VoyagerService,
    private readonly locations: LocationsService,
  ) {}

  // ── Search ──────────────────────────────────────────────────────────────────

  async search(params: SearchCompaniesDto): Promise<Company[]> {
    await this.session.ensureAuthenticated();
    const limit = Math.min(params.limit ?? 25, 100);

    // ── Primary: Voyager search/blended with resultType=COMPANIES ──────────
    const apiResults = await this.searchViaApi(params, limit);
    if (apiResults.length > 0) {
      for (const c of apiResults) await this.upsert(c);
      this.logger.log(`Voyager API → ${apiResults.length} companies`);
      return apiResults;
    }

    // ── Fallback: browser ──────────────────────────────────────────────────
    this.logger.log('Voyager API returned 0 — falling back to browser');
    return this.searchViaBrowser(params, limit);
  }

  // ── Voyager API path ────────────────────────────────────────────────────────

  private async searchViaApi(params: SearchCompaniesDto, limit: number): Promise<Company[]> {
    const queryParts: string[] = ['(key:resultType,value:List(COMPANIES))'];

    if (params.companySize?.length) {
      queryParts.push(`(key:companySize,value:List(${params.companySize.join(',')}))`);
    }
    if (params.companyType?.length) {
      queryParts.push(`(key:companyType,value:List(${params.companyType.join(',')}))`);
    }
    if (params.industry?.length) {
      // LinkedIn Voyager uses urn:li:industry:<id> with the industryV2 key
      const urns = params.industry.map((id) => `urn:li:industry:${id}`).join(',');
      queryParts.push(`(key:industryV2,value:List(${urns}))`);
    }

    // Resolve location to geoId
    const geoId = await this.resolveGeoId(params);
    this.logger.debug(`resolveGeoId → ${geoId ?? 'none'} (geoId param: ${params.geoId ?? '-'}, location: ${params.location ?? '-'})`);
    if (geoId) {
      queryParts.push(`(key:geoUrn,value:List(urn:li:geo:${geoId}))`);
    }

    // Has job listings filter
    if (params.hasJobListings) {
      queryParts.push(`(key:hasJobListings,value:List(true))`);
    }

    const keywords = params.keywords?.trim() ?? '';
    const keywordsPart = keywords ? `keywords:${keywords},` : '';
    const query = `(${keywordsPart}flagshipSearchIntent:SEARCH_SRP,queryParameters:List(${queryParts.join(',')}),includeFiltersInResponse:false)`;

    this.logger.debug(`Voyager query (limit=${limit}): ${query}`);

    // Try endpoints without and with decorationId — detect which works
    const ENDPOINT_VARIANTS: Record<string, string>[] = [
      { q: 'blended', query },
      { q: 'blended', query, decorationId: 'com.linkedin.voyager.deco.search.SearchCluster-137' },
      { q: 'blended', query, decorationId: 'com.linkedin.voyager.deco.search.SearchCluster-2' },
    ];

    const companies: Company[] = [];
    let start = 0;
    const pageSize = Math.min(limit, 25);

    // Probe each variant to find one that returns data
    let workingVariant: Record<string, string> | null = null;

    for (const variant of ENDPOINT_VARIANTS) {
      const probe = await this.voyager.get('search/blended', {
        ...variant,
        count: String(Math.min(pageSize, 5)),
        start: '0',
      } as Record<string, string>);
      if (probe) {
        workingVariant = variant;
        this.logger.debug(`Voyager variant OK: decorationId=${variant.decorationId ?? 'none'}`);
        // Process probe page
        const byUrn = this.voyager.buildUrnMap(probe);
        const topElements: any[] = probe?.data?.elements ?? probe?.elements ?? [];
        const hits: any[] = [];
        for (const el of topElements) hits.push(...(el?.elements ?? [el]));
        this.logger.debug(`Voyager probe: topElements=${topElements.length}, hits=${hits.length}`);
        for (const hit of hits) {
          if (companies.length >= limit) break;
          const company = this.parseCompanyHit(hit, byUrn);
          if (company && !companies.find((c) => c.id === company.id)) companies.push(company);
        }
        start = Math.min(pageSize, 5);
        break;
      }
      this.logger.warn(`Voyager variant failed: decorationId=${variant.decorationId ?? 'none'}`);
    }

    if (!workingVariant) {
      this.logger.warn('All Voyager variants failed — will use browser fallback');
      return [];
    }

    while (companies.length < limit) {
      const data = await this.voyager.get('search/blended', {
        ...workingVariant,
        count: String(pageSize),
        start: String(start),
      } as Record<string, string>);

      if (!data) {
        this.logger.warn(`Voyager returned null (start=${start})`);
        break;
      }

      const byUrn = this.voyager.buildUrnMap(data);
      const topElements: any[] = data?.data?.elements ?? data?.elements ?? [];
      const hits: any[] = [];
      for (const el of topElements) hits.push(...(el?.elements ?? [el]));

      this.logger.debug(
        `Voyager page start=${start}: topElements=${topElements.length}, hits=${hits.length}, ` +
        `paging.total=${data?.data?.paging?.total ?? data?.paging?.total ?? '?'}`,
      );

      if (!hits.length) break;

      for (const hit of hits) {
        if (companies.length >= limit) break;
        const company = this.parseCompanyHit(hit, byUrn);
        if (company && !companies.find((c) => c.id === company.id)) {
          companies.push(company);
        }
      }

      start += pageSize;
      const total = data?.data?.paging?.total ?? data?.paging?.total ?? 0;
      if (start >= total || hits.length < pageSize) break;
    }

    this.logger.debug(`Voyager API returned ${companies.length} companies (limit was ${limit})`);
    return companies;
  }

  private parseCompanyHit(el: any, byUrn: Map<string, any>): Company | null {
    const hitInfo = el?.hitInfo ?? {};
    const companyInfo =
      hitInfo['com.linkedin.voyager.search.SearchCompany'] ??
      Object.values(hitInfo).find((v: any) => v?.company) as any;

    const companyUrn: string =
      companyInfo?.company ??
      el?.targetUrn ??
      el?.entityUrn ??
      '';

    if (!companyUrn) return null;

    const company = byUrn.get(companyUrn);
    if (!company) return null;

    const slug: string = company.universalName ?? company.id ?? companyUrn.split(':').pop() ?? '';
    if (!slug) return null;

    // Extract numeric LinkedIn company ID from the URN: "urn:li:company:1441" → "1441"
    const linkedinId = companyUrn.match(/urn:li:company:(\d+)/)?.[1] ?? null;

    return {
      id: slug,
      linkedin_id: linkedinId,
      name: company.name ?? companyInfo?.name ?? '',
      url: `https://www.linkedin.com/company/${slug}`,
      industry: company.industries?.[0]?.localizedName ?? company.industry ?? null,
      size: company.staffCountRange
        ? `${company.staffCountRange.start ?? ''}–${company.staffCountRange.end ?? ''}+`
        : null,
      headline: company.tagline ?? company.description?.text?.slice(0, 200) ?? null,
      location: company.headquarter
        ? [company.headquarter.city, company.headquarter.country].filter(Boolean).join(', ')
        : null,
      follower_count: company.followingInfo?.followerCount
        ? String(company.followingInfo.followerCount)
        : null,
      company_type: company.companyType?.localizedName ?? null,
      scraped_at: new Date().toISOString(),
    };
  }

  // ── Browser fallback ────────────────────────────────────────────────────────

  private async searchViaBrowser(params: SearchCompaniesDto, limit: number): Promise<Company[]> {
    const url = await this.buildSearchUrl(params);
    this.logger.log(`Browser fallback URL: ${url}`);

    const page = await this.browser.newPage();
    const companies: Company[] = [];

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      // Wait for LinkedIn's JS to apply URL-based filters and render results
      await this.delay(3500, 5000);

      // LinkedIn new UI paginates with numbered buttons: aria-label="Página 1", "Página 2"…
      // There is no "Next" button — we track the current page and click the next number.
      let currentPage = 1;
      let attempts = 0;
      while (companies.length < limit && attempts < 8) {
        // LinkedIn's new UI wraps the full card content inside the <a href="/company/...">
        // element itself — no stable data-* attribute or readable class name exists.
        const seenSlugs = new Set(companies.map(c => c.id));
        const links = await page.$$('a[href*="/company/"]');
        const cards: any[] = [];
        for (const link of links) {
          const href = (await link.getAttribute('href').catch(() => null)) ?? '';
          const slug = href.match(/\/company\/([^/?#]+)/)?.[1];
          if (!slug || seenSlugs.has(slug)) continue;
          seenSlugs.add(slug);
          cards.push(link);
        }
        this.logger.debug(`Found ${cards.length} company cards on page ${currentPage}`);

        for (const card of cards) {
          if (companies.length >= limit) break;
          try {
            const company = await this.extractCompanyCard(card);
            if (company && !companies.find((c) => c.id === company.id)) {
              companies.push(company);
              await this.upsert(company);
            }
          } catch { /* skip malformed card */ }
        }

        if (companies.length >= limit) break;

        currentPage++;
        const nextBtn = await page.$(
          `button[aria-label="Página ${currentPage}"], ` +
          `button[aria-label="Page ${currentPage}"]`,
        );
        if (!nextBtn) break;
        await nextBtn.click();
        await this.delay(2500, 4000);
        attempts++;
      }
    } finally {
      await page.close();
    }

    this.logger.log(`Browser found ${companies.length} companies`);
    return companies;
  }

  private async extractCompanyCard(card: any): Promise<Company | null> {
    // LinkedIn new UI: the card IS the <a href="/company/..."> element —
    // the entire card content (name, industry, location) is inside the anchor.
    // Old UI fallback: card is a wrapper element containing a child <a>.
    const tagName: string = await card
      .evaluate((el: Element) => el.tagName.toLowerCase())
      .catch(() => '');

    let href: string;
    if (tagName === 'a') {
      href = (await card.getAttribute('href').catch(() => null)) ?? '';
    } else {
      const linkEl = await card.$('a[href*="/company/"]');
      if (!linkEl) return null;
      href = (await linkEl.getAttribute('href').catch(() => null)) ?? '';
    }

    const slug = href.match(/\/company\/([^/?#]+)/)?.[1];
    if (!slug) return null;

    const innerText: string = await card.evaluate(
      (el: Element) => (el as HTMLElement).innerText ?? '',
    );

    const SKIP = /^(seguir|follow|conectar|connect|mensaje|message|ver empresa|see company|members|empleados|seguidores|followers)/i;
    const lines = innerText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !SKIP.test(l));

    const name = lines[0] ?? '';
    if (!name) return null;

    // Lines after name: typically industry • size • location
    const meta = lines.slice(1).filter((l) => l.length > 1);
    const industry = meta[0] ?? null;
    const sizeLine = meta.find((l) => /\d/.test(l) || l.includes('empleados') || l.includes('employees')) ?? null;
    const location = meta.find((l) => l !== industry && l !== sizeLine && l.length > 2) ?? null;

    // Follower count often appears as "X seguidores" or "X followers"
    const followerLine = lines.find((l) => /seguidores|followers/i.test(l));
    const follower_count = followerLine?.match(/[\d,\.]+/)?.[0] ?? null;

    return {
      id: slug,
      linkedin_id: null,   // resolved separately via resolveCompanyLinkedInId()
      name,
      url: `https://www.linkedin.com/company/${slug}`,
      industry,
      size: sizeLine,
      headline: meta[meta.length - 1] !== location ? meta[meta.length - 1] : null,
      location,
      follower_count,
      company_type: null,
      scraped_at: new Date().toISOString(),
    };
  }

  // ── People at a company ─────────────────────────────────────────────────────

  /**
   * Search LinkedIn people filtered by company.
   * Uses /search/results/people/?currentCompany=[numericId] — much more accurate
   * than the old /company/:slug/people/ page.
   * Optionally filters by `keywords` (role, skills, etc.) — broader than titleFreeText.
   */
  async searchPeopleAtCompany(companyId: string, params: SearchPeopleAtCompanyDto): Promise<Person[]> {
    await this.session.ensureAuthenticated();

    const company = await this.findById(companyId);
    const limit = Math.min(params.limit ?? 25, 100);

    // ── Resolve the numeric LinkedIn company ID ────────────────────────────────
    // We need it for the currentCompany URL filter. Try stored value first.
    const linkedinId = company.linkedin_id ?? await this.resolveCompanyLinkedInId(company.id);

    // Persist the resolved ID so we don't have to look it up again
    if (linkedinId && !company.linkedin_id) {
      await this.db.execute(
        `UPDATE companies SET linkedin_id = ? WHERE id = ?`,
        [linkedinId, company.id],
      ).catch(() => {});
    }

    // ── Build search URL ──────────────────────────────────────────────────────
    let url: string;
    if (linkedinId) {
      const p = new URLSearchParams();
      // currentCompany accepts an array of numeric IDs — same format as geoUrn
      p.set('currentCompany', JSON.stringify([linkedinId]));
      p.set('origin', 'FACETED_SEARCH');
      if (params.keywords) {
        // `keywords` searches across name, title, headline — less restrictive than titleFreeText
        p.set('keywords', params.keywords);
      }
      url = `https://www.linkedin.com/search/results/people/?${p.toString()}`;
      this.logger.log(`People search at "${company.name}" (id:${linkedinId}): ${url}`);
    } else {
      // Fallback: org people page (works without numeric ID)
      url = `https://www.linkedin.com/company/${company.id}/people/`;
      if (params.keywords) url += `?keywords=${encodeURIComponent(params.keywords)}`;
      this.logger.log(`Fallback org page for "${company.name}": ${url}`);
    }

    const page = await this.browser.newPage();
    const people: Person[] = [];

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this.delay(3000, 4000);

      // LinkedIn new UI: card content lives inside the <a href="/in/..."> element.
      // Paginate via aria-label="Página N" numbered buttons (no "Next" button exists).
      let currentPage = 1;
      let attempts = 0;
      while (people.length < limit && attempts < 8) {
        const seenUrls = new Set(people.map(p => p.profile_url));
        const links = await page.$$('a[href*="/in/"]');
        const cards: any[] = [];
        for (const link of links) {
          const href = (await link.getAttribute('href').catch(() => null)) ?? '';
          const slug = href.match(/\/in\/([^/?#]+)/)?.[1];
          if (!slug) continue;
          const profileUrl = `https://www.linkedin.com/in/${slug}`;
          if (seenUrls.has(profileUrl)) continue;
          seenUrls.add(profileUrl);
          cards.push(link);
        }
        this.logger.debug(`People cards found on page ${currentPage}: ${cards.length}`);

        for (const card of cards) {
          if (people.length >= limit) break;
          try {
            const person = await this.extractPersonSearchCard(card, company.name);
            if (person && !people.find((p) => p.profile_url === person.profile_url)) {
              people.push(person);
              await this.upsertPerson(person);
            }
          } catch { /* skip malformed card */ }
        }

        if (people.length >= limit) break;

        currentPage++;
        const nextBtn = await page.$(
          `button[aria-label="Página ${currentPage}"], button[aria-label="Page ${currentPage}"]`,
        );
        if (!nextBtn) break;
        await nextBtn.click();
        await this.delay(2500, 4000);
        attempts++;
      }
    } finally {
      await page.close();
    }

    this.logger.log(`Found ${people.length} people at "${company.name}"`);
    return people;
  }

  /**
   * Resolve the numeric LinkedIn company ID from a slug.
   * Tries Voyager first, then extracts from the company page with authenticated browser.
   */
  private async resolveCompanyLinkedInId(slug: string): Promise<string | null> {
    // ── 1. Voyager: organization/companies?q=universalName ─────────────────
    for (const decorationId of [
      undefined,
      'com.linkedin.voyager.deco.organization.web.WebBasicCompanyProfile-33',
    ]) {
      const params: Record<string, string> = { q: 'universalName', universalName: slug };
      if (decorationId) params.decorationId = decorationId;

      const data = await this.voyager.get('organization/companies', params);
      if (data) {
        // The numeric ID lives in the entityUrn of the company entity
        const included: any[] = data?.included ?? [];
        const elements: any[] = data?.data?.elements ?? data?.elements ?? [];
        const allEntities = [...included, ...elements, data?.data, data].filter(Boolean);

        for (const entity of allEntities) {
          const urn: string = entity?.entityUrn ?? '';
          const id = urn.match(/urn:li:company:(\d+)/)?.[1];
          if (id) {
            this.logger.debug(`Company ID via Voyager: ${slug} → ${id}`);
            return id;
          }
        }
        this.logger.debug(`Voyager organization/companies returned data but no URN for ${slug}`);
      }
    }

    // ── 2. Browser: navigate with authenticated session and extract from page ─
    // LinkedIn embeds all entity data in <code> tags as JSON (server-side rendered)
    // These are only populated when the session cookies are present.
    const page = await this.browser.newPage();
    try {
      await page.goto(`https://www.linkedin.com/company/${slug}/about/`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      // Give LinkedIn JS time to hydrate the code tags
      await this.delay(3000, 4000);

      const result = await page.evaluate(() => {
        // Pattern 1: <code> tags contain serialised React state with entityUrn
        const allText = Array.from(document.querySelectorAll('code'))
          .map(c => c.textContent ?? '')
          .join(' ');

        const urnMatch = allText.match(/urn:li:(?:fs_)?company:(\d+)/);
        if (urnMatch) return urnMatch[1];

        // Pattern 2: scripts may embed the URN too
        const scriptText = Array.from(document.querySelectorAll('script:not([src])'))
          .map(s => s.textContent ?? '')
          .join(' ');
        const scriptMatch = scriptText.match(/urn:li:(?:fs_)?company:(\d+)/);
        if (scriptMatch) return scriptMatch[1];

        // Pattern 3: data-* attributes on page elements
        const dataEl = document.querySelector('[data-company-id]');
        if (dataEl) return dataEl.getAttribute('data-company-id');

        return null;
      }).catch(() => null);

      if (result) {
        this.logger.debug(`Company ID via page: ${slug} → ${result}`);
        return result;
      }

      // Log what we found for debugging
      const codeSample = await page.evaluate(() => {
        const codes = Array.from(document.querySelectorAll('code'));
        return codes.map(c => c.textContent?.substring(0, 100) ?? '').filter(Boolean).slice(0, 3);
      }).catch(() => [] as string[]);
      this.logger.debug(`No ID found. Code tag samples: ${JSON.stringify(codeSample)}`);

    } finally {
      await page.close();
    }

    this.logger.warn(`Could not resolve numeric LinkedIn ID for "${slug}" — using org people page fallback`);
    return null;
  }

  /** Extract a person from a standard people-search result card.
   *  LinkedIn new UI: card IS the <a href="/in/..."> element — the whole card lives inside it. */
  private async extractPersonSearchCard(card: any, companyName: string): Promise<Person | null> {
    const tagName: string = await card
      .evaluate((el: Element) => el.tagName.toLowerCase())
      .catch(() => '');

    let href: string;
    if (tagName === 'a') {
      href = (await card.getAttribute('href').catch(() => null)) ?? '';
    } else {
      const linkEl = await card.$('a[href*="/in/"]');
      if (!linkEl) return null;
      href = (await linkEl.getAttribute('href').catch(() => null)) ?? '';
    }

    const slug = href.match(/\/in\/([^/?#]+)/)?.[1];
    if (!slug) return null;

    const innerText: string = await card.evaluate(
      (el: Element) => (el as HTMLElement).innerText ?? '',
    );

    // Mutual-connection mentions ("Ana, Luis y 3 contactos más en común") render as
    // bare /in/ links whose text is ONLY the person's name. A real result card always
    // carries several lines (name, headline, location, buttons…), so a single-line
    // link is NOT a search result — skip it or it gets saved with the searched
    // company stamped on it despite not working there.
    const rawLines = innerText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (rawLines.length < 2) return null;

    // Skip UI noise: action buttons, degree indicators, and LinkedIn profile badges.
    // "Localizable" = open-to-connect badge; "Con conexión" = 1st-degree badge —
    // both appear as the first text node in some cards and must not be mistaken for the name.
    // Degree extracted from raw text before any filtering (handles inline and separate-line formats).
    let connectionDegree: string | null = null;
    const degreeMatch = innerText.match(/•\s*(\d+[ºa-z°]*|3er\+)/i);
    if (degreeMatch) {
      connectionDegree = degreeMatch[1].replace('º', '');
    } else if (/con conexi[oó]n/i.test(innerText)) {
      connectionDegree = '1';
    }

    const SKIP_LINE = /^(conectar|connect|mensaje|message|seguir|follow|ver perfil|see profile|pendiente|pending|invitaci[oó]n|invitation|localizable|con conexi[oó]n|open to connect|•\s*\d|•\s*[12]|•\s*3|\d+\s*contactos|contactos.*com[uú]n|mutual.*connection)/i;
    const lines = innerText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !SKIP_LINE.test(l));

    // Strip inline degree indicator from name ("Ana Díaz • 2º" → "Ana Díaz")
    const name = (lines[0] ?? '').replace(/\s*•\s*\d+[ºa-z°]*/i, '').trim();
    if (!name || /linkedin member|miembro de linkedin/i.test(name)) return null;

    return {
      id: slug,
      name,
      headline: lines[1] ?? null,   // job title / headline
      location: lines[2] ?? null,   // city / country
      profile_url: `https://www.linkedin.com/in/${slug}`,
      connection_degree: connectionDegree,
      company: companyName,
      scraped_at: new Date().toISOString(),
    };
  }

  // ── DB helpers ──────────────────────────────────────────────────────────────

  async findAll(filters: {
    keyword?: string;
    industry?: string;
    size?: string;
    location?: string;
    company_type?: string;
  } = {}): Promise<Company[]> {
    let query = 'SELECT * FROM companies WHERE 1=1';
    const params: any[] = [];

    if (filters.keyword) {
      query += ' AND (name LIKE ? OR headline LIKE ?)';
      params.push(`%${filters.keyword}%`, `%${filters.keyword}%`);
    }
    if (filters.industry) {
      query += ' AND industry LIKE ?';
      params.push(`%${filters.industry}%`);
    }
    if (filters.size) {
      query += ' AND size LIKE ?';
      params.push(`%${filters.size}%`);
    }
    if (filters.location) {
      query += ' AND location LIKE ?';
      params.push(`%${filters.location}%`);
    }
    if (filters.company_type) {
      query += ' AND company_type LIKE ?';
      params.push(`%${filters.company_type}%`);
    }

    query += ' ORDER BY scraped_at DESC';
    return this.db.query<Company>(query, params);
  }

  async findById(id: string): Promise<Company> {
    const company = await this.db.queryOne<Company>('SELECT * FROM companies WHERE id = ?', [id]);
    if (!company) throw new NotFoundException(`Company "${id}" not found in DB. Run a search first.`);
    return company;
  }

  private async upsert(c: Company): Promise<void> {
    await this.db.execute(
      `INSERT INTO companies (id, linkedin_id, name, url, industry, size, headline, location, follower_count, company_type, scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         linkedin_id = COALESCE(EXCLUDED.linkedin_id, linkedin_id),
         name = EXCLUDED.name, url = EXCLUDED.url, industry = EXCLUDED.industry,
         size = EXCLUDED.size, headline = EXCLUDED.headline, location = EXCLUDED.location,
         follower_count = EXCLUDED.follower_count, company_type = EXCLUDED.company_type,
         scraped_at = EXCLUDED.scraped_at`,
      [c.id, c.linkedin_id, c.name, c.url, c.industry, c.size, c.headline, c.location, c.follower_count, c.company_type, c.scraped_at],
    );
  }

  private async upsertPerson(p: Person): Promise<void> {
    await this.db.execute(
      `INSERT INTO people (id, name, headline, location, profile_url, connection_degree, company, scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, headline = EXCLUDED.headline, location = EXCLUDED.location,
         profile_url = EXCLUDED.profile_url, connection_degree = EXCLUDED.connection_degree,
         company = EXCLUDED.company, scraped_at = EXCLUDED.scraped_at`,
      [p.id, p.name, p.headline, p.location, p.profile_url, p.connection_degree, p.company, p.scraped_at],
    );
  }

  // ── URL builder ─────────────────────────────────────────────────────────────

  private async buildSearchUrl(params: SearchCompaniesDto): Promise<string> {
    const base = 'https://www.linkedin.com/search/results/companies/';
    const p = new URLSearchParams();

    if (params.keywords) p.set('keywords', params.keywords);

    // LinkedIn company search uses FACETED_SEARCH origin (not SWITCH_SEARCH_VERTICAL)
    p.set('origin', 'FACETED_SEARCH');

    // Company size — letter codes in a JSON array: ["B","C"]
    if (params.companySize?.length) {
      p.set('companySize', JSON.stringify(params.companySize));
    }

    // Company type — letter codes: ["G"]
    if (params.companyType?.length) {
      p.set('companyType', JSON.stringify(params.companyType));
    }

    // Industry — company search uses "industryCompanyVertical", NOT "industry" or "industryV2"
    // Same numeric IDs as our COMMON_INDUSTRIES list
    if (params.industry?.length) {
      p.set('industryCompanyVertical', JSON.stringify(params.industry));
    }

    // Location — company search uses "companyHqGeo", NOT "geoUrn"
    const geoId = await this.resolveGeoId(params);
    if (geoId) {
      p.set('companyHqGeo', JSON.stringify([geoId]));
    }

    if (params.hasJobListings) {
      p.set('hasJobListings', 'true');
    }

    return `${base}?${p.toString()}`;
  }

  private async resolveGeoId(params: { geoId?: string; location?: string }): Promise<string | null> {
    if (params.geoId) return params.geoId;
    if (!params.location) return null;

    try {
      const results = await this.locations.typeahead(params.location);
      return results[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  private delay(min: number, max: number) {
    return new Promise((r) => setTimeout(r, Math.random() * (max - min) + min));
  }
}
