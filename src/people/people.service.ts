import { Injectable, Logger } from '@nestjs/common';
import { BrowserService } from '../common/browser/browser.service';
import { DatabaseService } from '../common/database/database.service';
import { SessionService } from '../session/session.service';
import { VoyagerService } from '../common/voyager/voyager.service';
import { resolveGeoUrn } from '../common/location-urns';

export interface Person {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  profile_url: string;
  connection_degree: string | null;
  company: string | null;
  scraped_at: string;
}

export interface PeopleSearchParams {
  keywords: string;
  company?: string;
  connectionDegree?: '1st' | '2nd' | '3rd';
  location?: string;
  geoId?: string;
  limit?: number;
}

@Injectable()
export class PeopleService {
  private readonly logger = new Logger(PeopleService.name);

  constructor(
    private readonly browser: BrowserService,
    private readonly db: DatabaseService,
    private readonly session: SessionService,
    private readonly voyager: VoyagerService,
  ) {}

  async search(params: PeopleSearchParams): Promise<Person[]> {
    await this.session.ensureAuthenticated();
    const limit = params.limit ?? 25;

    // ── Primary: Voyager search/blended API (no browser) ─────────────────
    const apiPeople = await this.searchViaApi(params, limit);
    if (apiPeople.length > 0) {
      for (const p of apiPeople) await this.upsertPerson(p);
      this.logger.log(`search/blended API → ${apiPeople.length} people`);
      return apiPeople;
    }

    // ── Fallback: browser scraping ────────────────────────────────────────
    this.logger.log(`API returned 0 results — falling back to browser`);
    return this.searchViaBrowser(params, limit);
  }

  // ── Voyager API search ────────────────────────────────────────────────────

  private async searchViaApi(params: PeopleSearchParams, limit: number): Promise<Person[]> {
    const degreeMap: Record<string, string> = { '1st': 'F', '2nd': 'S', '3rd': 'O' };
    const queryParams: string[] = [`(key:resultType,value:List(PEOPLE))`];

    if (params.connectionDegree) {
      queryParams.push(`(key:network,value:List(${degreeMap[params.connectionDegree]}))`);
    }

    const geoId = params.geoId ?? (params.location ? resolveGeoUrn(params.location) : null);
    if (geoId) {
      queryParams.push(`(key:geoUrn,value:List(urn:li:geo:${geoId}))`);
    }

    if (params.company) {
      queryParams.push(`(key:currentCompany,value:List(${params.company}))`);
    }

    const query = `(keywords:${params.keywords},flagshipSearchIntent:SEARCH_SRP,queryParameters:List(${queryParams.join(',')}),includeFiltersInResponse:false)`;

    const people: Person[] = [];
    let start = 0;
    const pageSize = Math.min(limit, 25);

    while (people.length < limit) {
      const data = await this.voyager.get('search/blended', {
        q: 'blended',
        query,
        decorationId: 'com.linkedin.voyager.deco.search.SearchCluster-137',
        count: String(pageSize),
        start: String(start),
      });

      if (!data) break;

      const byUrn = this.voyager.buildUrnMap(data);
      // Blended search has elements inside a cluster element
      const topElements: any[] = data?.data?.elements ?? data?.elements ?? [];
      const allHits: any[] = [];
      for (const el of topElements) {
        allHits.push(...(el?.elements ?? [el]));
      }

      if (allHits.length === 0) break;

      for (const hit of allHits) {
        if (people.length >= limit) break;
        const person = this.parsePersonHit(hit, byUrn);
        if (person && !people.find((p) => p.profile_url === person.profile_url)) {
          people.push(person);
        }
      }

      start += pageSize;
      const total = data?.data?.paging?.total ?? data?.paging?.total ?? 0;
      if (start >= total || allHits.length < pageSize) break;
    }

    return people;
  }

  private parsePersonHit(el: any, byUrn: Map<string, any>): Person | null {
    const hitInfo = el.hitInfo ?? {};
    const profileInfo =
      hitInfo['com.linkedin.voyager.search.SearchProfile'] ??
      Object.values(hitInfo).find((v: any) => v?.profileUrn) as any;

    const profileUrn: string = profileInfo?.profileUrn ?? '';
    if (!profileUrn) return null;

    const profile = byUrn.get(profileUrn);
    if (!profile) return null;

    const slug = profile.publicIdentifier;
    if (!slug) return null;

    const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    if (!name || name.toLowerCase().includes('linkedin')) return null;

    const distanceVal: string = profile.distance?.value ?? '';
    const connectionDegree = distanceVal.includes('1')
      ? '1st' : distanceVal.includes('2')
      ? '2nd' : distanceVal.includes('3')
      ? '3rd' : null;

    return {
      id: slug,
      name,
      headline: profile.occupation ?? null,
      location: profile.locationName ?? null,
      profile_url: `https://www.linkedin.com/in/${slug}`,
      connection_degree: connectionDegree,
      company: null,
      scraped_at: new Date().toISOString(),
    };
  }

  // ── Browser fallback ──────────────────────────────────────────────────────

  private async searchViaBrowser(params: PeopleSearchParams, limit: number): Promise<Person[]> {
    const url = this.buildSearchUrl(params);
    this.logger.log(`Browser search: ${url}`);

    const page = await this.browser.newPage();
    const people: Person[] = [];

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this.delay(2000, 3000);

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
        this.logger.debug(`Found ${cards.length} people cards on page ${currentPage}`);

        for (const card of cards) {
          if (people.length >= limit) break;
          try {
            const person = await this.extractPersonCard(card);
            if (person && !people.find((p) => p.profile_url === person.profile_url)) {
              people.push(person);
              await this.upsertPerson(person);
            }
          } catch { /* skip */ }
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

    this.logger.log(`Browser found ${people.length} people`);
    return people;
  }

  // ── DB queries ────────────────────────────────────────────────────────────

  async findAll(filters: { keyword?: string; company?: string; connectionDegree?: string; location?: string } = {}): Promise<Person[]> {
    let query = 'SELECT * FROM people WHERE 1=1';
    const params: any[] = [];

    if (filters.keyword) {
      query += ' AND (name LIKE ? OR headline LIKE ?)';
      params.push(`%${filters.keyword}%`, `%${filters.keyword}%`);
    }
    if (filters.company) {
      query += ' AND company LIKE ?';
      params.push(`%${filters.company}%`);
    }
    if (filters.connectionDegree) {
      query += ' AND connection_degree = ?';
      params.push(filters.connectionDegree);
    }
    if (filters.location) {
      query += ' AND location LIKE ?';
      params.push(`%${filters.location}%`);
    }

    query += ' ORDER BY scraped_at DESC';
    return this.db.query<Person>(query, params);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private buildSearchUrl(params: PeopleSearchParams): string {
    const base = 'https://www.linkedin.com/search/results/people/';
    const p = new URLSearchParams();
    p.set('keywords', params.keywords);

    if (params.geoId) {
      p.set('geoUrn', `["${params.geoId}"]`);
    } else if (params.location) {
      const geoId = resolveGeoUrn(params.location);
      if (geoId) {
        p.set('geoUrn', `["${geoId}"]`);
      } else {
        this.logger.warn(`Unknown location "${params.location}" — appending to keywords`);
        p.set('keywords', `${params.keywords} ${params.location}`);
      }
    }

    const degreeMap: Record<string, string> = { '1st': 'F', '2nd': 'S', '3rd': 'O' };
    if (params.connectionDegree) p.set('network', `["${degreeMap[params.connectionDegree]}"]`);
    if (params.company) p.set('currentCompany', `["${params.company}"]`);
    return `${base}?${p.toString()}`;
  }

  private async extractPersonCard(card: any): Promise<Person | null> {
    // LinkedIn new UI: card IS the <a href="/in/..."> element.
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

    if (!href) return null;
    const slug = href.match(/\/in\/([^/?#]+)/)?.[1];
    if (!slug) return null;
    const profileUrl = `https://www.linkedin.com/in/${slug}`;

    const innerText: string = await card.evaluate((el: Element) => (el as HTMLElement).innerText ?? '');

    // Extract degree from raw text before filtering (handles both inline and separate-line formats).
    let connectionDegree: string | null = null;
    const degreeMatch = innerText.match(/•\s*(\d+[ºa-z°]*|3er\+)/i);
    if (degreeMatch) {
      connectionDegree = degreeMatch[1].replace('º', '');
    } else if (/con conexi[oó]n/i.test(innerText)) {
      connectionDegree = '1';
    }

    const SKIP_LINE = /^(estado:|status:|activo|active|localizable|con conexi[oó]n|open to connect|online|siguiendo|following|connect|conectar|mensaje|message|pendiente|pending|invitaci[oó]n|invitation|•\s*\d|•\s*[12]|•\s*3|\d+\s*contactos|contactos.*com[uú]n|mutual.*connection)/i;
    const lines = innerText.split('\n').map((l) => l.trim()).filter((l) => l && !SKIP_LINE.test(l));
    if (lines.length < 1) return null;

    // Strip inline degree indicator from name ("Ana Díaz • 2º" → "Ana Díaz")
    const name = (lines[0] ?? '').replace(/\s*•\s*\d+[ºa-z°]*/i, '').trim();
    if (!name || name === 'LinkedIn Member' || name === 'Miembro de LinkedIn') return null;

    const headline = lines[1] && !lines[1].startsWith('•') ? lines[1] : null;
    const location = lines[2] && !lines[2].startsWith('•') ? lines[2] : null;
    const company = headline?.match(/(?:en|at|@)\s+(.+)/i)?.[1]?.trim() ?? null;

    return {
      id: slug, name, headline, location,
      profile_url: profileUrl, connection_degree: connectionDegree,
      company, scraped_at: new Date().toISOString(),
    };
  }

  private async upsertPerson(person: Person): Promise<void> {
    await this.db.execute(
      `INSERT INTO people
         (id, name, headline, location, profile_url, connection_degree, company, scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, headline = EXCLUDED.headline, location = EXCLUDED.location,
         connection_degree = EXCLUDED.connection_degree, company = EXCLUDED.company,
         scraped_at = EXCLUDED.scraped_at`,
      [person.id, person.name, person.headline, person.location,
       person.profile_url, person.connection_degree, person.company, person.scraped_at],
    );
  }

  private delay(min: number, max: number) {
    return new Promise((r) => setTimeout(r, Math.random() * (max - min) + min));
  }
}
