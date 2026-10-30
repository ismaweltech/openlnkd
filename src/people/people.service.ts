import { Injectable, Logger } from '@nestjs/common';
import { BrowserService } from '../common/browser/browser.service';
import { DatabaseService } from '../common/database/database.service';
import { SessionService } from '../session/session.service';
import { VoyagerService } from '../common/voyager/voyager.service';
import { resolveGeoUrn } from '../common/location-urns';
import { LocationsService } from '../locations/locations.service';

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

export interface ActivityPost {
  /** 'post' = authored by this person, 'repost' = shared from someone else */
  type: 'post' | 'repost';
  /** full visible text of the update (author header + body, cleaned) */
  text: string;
  /** post body only, with the repost/author header stripped */
  body: string;
  /** relative age as LinkedIn shows it ("4 d", "2 sem", "1 mes") */
  age: string | null;
  /** age converted to days (approximate: 1 sem = 7, 1 mes = 30, 1 año = 365) */
  days: number | null;
  /** reactions + comments counts when present on the card */
  reactions: number | null;
  comments: number | null;
  /** times shared ("1 vez compartido") */
  reposts: number | null;
  /**
   * Impressions (reach). LinkedIn only shows these to the post's author, so this
   * is filled in only when scraping your own profile — null for anyone else.
   */
  impressions: number | null;
  /** attachment: none, one photo, several photos, video, or PDF document (carousel) */
  media: 'text' | 'image' | 'images' | 'video' | 'document';
  /** image carries LinkedIn's content-credentials (C2PA) badge — usually AI-generated */
  contentCredentials: boolean;
}

export interface ProfileSummary {
  slug: string;
  name: string | null;
  headline: string | null;
  followers: number | null;
  metrics: {
    postsSampled: number;
    ownPosts: number;
    /** share of sampled items that are authored (vs reposts), 0–1 */
    ownRatio: number | null;
    /** median reactions+comments across own posts — robust to one viral outlier */
    medianEngagement: number | null;
    maxEngagement: number | null;
    /** days since the most recent own post */
    lastOwnPostDays: number | null;
    ownPostsLast30d: number;
  };
  posts: ActivityPost[];
}

export interface ActivityComment {
  /** the person's own comment text (the candid part) */
  comment: string;
  /** author of the post they commented on */
  onPostBy: string | null;
  /** short snippet of that post, for topic/context */
  onPost: string | null;
  /** relative age as LinkedIn shows it */
  age: string | null;
  /** true when it's a reply in the person's own post thread (less candid than commenting on others) */
  onOwnPost: boolean;
}

@Injectable()
export class PeopleService {
  private readonly logger = new Logger(PeopleService.name);

  constructor(
    private readonly browser: BrowserService,
    private readonly db: DatabaseService,
    private readonly session: SessionService,
    private readonly voyager: VoyagerService,
    private readonly locations: LocationsService,
  ) {}

  async search(params: PeopleSearchParams): Promise<Person[]> {
    await this.session.ensureAuthenticated();
    const limit = params.limit ?? 25;
    if (!params.geoId && params.location) {
      const geoId = await this.resolvePeopleGeo(params.location);
      if (geoId) params = { ...params, geoId };
    }

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
      // Results render client-side and their timing varies a lot (2–10 s): wait
      // until either profile links or the "no results" message are on the page.
      await page
        .waitForFunction(
          () => !!document.querySelector('main a[href*="/in/"], a[href*="/in/"]') ||
            /no se han encontrado resultados|no results found/i.test(document.body?.innerText ?? ''),
          null,
          { timeout: 15000 },
        )
        .catch(() => null);
      await this.delay(800, 1300);

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

  /**
   * People search only accepts metro/region geos: since Oct 2026 a city geo
   * ("Sevilla, Andalucía, España") returns "no results" while the metro one
   * ("Sevilla y alrededores") works. Job search still takes the city, so this is
   * people-specific. Countries and regions resolve through the static map.
   */
  private async resolvePeopleGeo(location: string): Promise<string | undefined> {
    const norm = (x: string) => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const q = norm(location);
    try {
      const results = await this.locations.typeahead(location);
      const metro = results.find((r) => {
        const l = norm(r.label);
        return [`${q} y alrededores`, `greater ${q} area`, `${q} metropolitan area`, `area metropolitana de ${q}`].includes(l);
      });
      if (metro) {
        this.logger.debug(`People geo "${location}" → metro ${metro.label} (${metro.id})`);
        return metro.id;
      }
      // Regions ("Andalucía" → "Andalucía, España"): exact first segment + a country.
      const country = norm(process.env.OPENLNKD_LOCATION_COUNTRY ?? 'España');
      const region = results.find((r) => {
        const parts = r.label.split(',').map(norm);
        return parts.length === 2 && parts[0] === q && [country, 'spain'].includes(parts[1]);
      });
      if (region) {
        this.logger.debug(`People geo "${location}" → region ${region.label} (${region.id})`);
        return region.id;
      }
    } catch { /* fall back to the static map */ }
    return resolveGeoUrn(location);
  }

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

    // Mutual-connection mentions ("Ana, Luis y 3 contactos más en común") render as
    // bare /in/ links whose text is ONLY the person's name — a real result card always
    // carries several lines. A single-line link is not a search result: skip it.
    const rawLines = innerText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (rawLines.length < 2) return null;

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
    const name = (lines[0] ?? '').replace(/\s*•\s*\d+[ºa-z°]*\+?/i, '').trim();
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

  // ── Activity / posts ────────────────────────────────────────────────────────

  /**
   * Scrape a person's recent LinkedIn activity (their posts and reposts) for
   * audience research — spotting the topics, pains and patterns they talk about.
   *
   * Reads /in/<slug>/recent-activity/all/. Each post is a stable
   * [componentkey^="update-card-focus"] element (LinkedIn hashes CSS classes but
   * keeps componentkey). Scrolls to lazy-load more, then extracts text, type
   * (own post vs repost), age and engagement.
   */
  async getActivity(slug: string, limit = 10): Promise<ActivityPost[]> {
    const { posts } = await this.scrapeRecentActivity(slug, limit);
    this.logger.log(`Activity for ${slug}: ${posts.length} posts`);
    return posts;
  }

  /**
   * One-visit profile summary for benchmarking people (competitors, references,
   * personas): followers, headline, recent posts and engagement metrics.
   * The median is used on purpose — a single viral post shouldn't make someone
   * look consistently strong.
   */
  async getProfile(slug: string, limit = 8): Promise<ProfileSummary> {
    const r = await this.scrapeRecentActivity(slug, limit);
    const own = r.posts.filter((p) => p.type === 'post');
    const eng = own.map((p) => (p.reactions ?? 0) + (p.comments ?? 0)).sort((a, b) => a - b);
    const median = !eng.length
      ? null
      : eng.length % 2 ? eng[(eng.length - 1) / 2] : (eng[eng.length / 2 - 1] + eng[eng.length / 2]) / 2;
    const ownDays = own.map((p) => p.days).filter((d): d is number => d !== null);

    this.logger.log(`Profile ${slug}: ${r.followers ?? '?'} followers, ${own.length}/${r.posts.length} own posts`);
    return {
      slug,
      name: r.name,
      headline: r.headline,
      followers: r.followers,
      metrics: {
        postsSampled: r.posts.length,
        ownPosts: own.length,
        ownRatio: r.posts.length ? Math.round((own.length / r.posts.length) * 100) / 100 : null,
        medianEngagement: median,
        maxEngagement: eng.length ? eng[eng.length - 1] : null,
        lastOwnPostDays: ownDays.length ? Math.min(...ownDays) : null,
        ownPostsLast30d: ownDays.filter((d) => d <= 30).length,
      },
      posts: r.posts,
    };
  }

  /**
   * Single visit to /in/<slug>/recent-activity/all/ shared by getActivity and
   * getProfile. Each post is a stable [componentkey^="update-card-focus"] element
   * (LinkedIn hashes CSS classes but keeps componentkey). The left profile card on
   * the same page carries the name, headline and follower count.
   */
  private async scrapeRecentActivity(slug: string, limit: number): Promise<{
    posts: ActivityPost[]; followers: number | null; name: string | null; headline: string | null;
  }> {
    await this.session.ensureAuthenticated();
    const page = await this.browser.newPage();
    try {
      await page.goto(
        `https://www.linkedin.com/in/${slug}/recent-activity/all/`,
        { waitUntil: 'domcontentloaded', timeout: 25000 },
      );
      await this.delay(3000, 4000);

      // Lazy-load: scroll until we have enough post cards (or we stop growing).
      let last = 0;
      for (let i = 0; i < 12; i++) {
        const count = await page
          .$$eval('[componentkey^="update-card-focus"]', (els) => els.length)
          .catch(() => 0);
        if (count >= limit) break;
        if (count === last && i > 2) break; // no new posts loading → stop
        last = count;
        await page.evaluate(() => window.scrollBy(0, 1400));
        await this.delay(1000, 1500);
      }

      const result = await page.evaluate((max) => {
        const parseCount = (s: string): number | null => {
          const m = s.replace(/[.,]/g, '').match(/(\d+)/);
          if (!m) return null;
          let n = parseInt(m[1], 10);
          if (/mil|k/i.test(s)) n *= 1000;
          return n;
        };

        // Left profile card: "<name>\n<headline>\nSeguidores\n1.637\n…"
        const pageLines = (document.body.innerText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
        const fi = pageLines.findIndex((l) => /^(seguidores|followers)$/i.test(l));
        const followers = fi >= 0 && pageLines[fi + 1] ? parseCount(pageLines[fi + 1]) : null;
        const headline = fi >= 1 ? pageLines[fi - 1] : null;
        const name = fi >= 2 ? pageLines[fi - 2] : null;

        const cards = Array.from(document.querySelectorAll<HTMLElement>('[componentkey^="update-card-focus"]'));
        const out: any[] = [];
        for (const card of cards) {
          if (out.length >= max) break;
          const full = (card.innerText ?? '').replace(/\r|\u200b/g, '').trim();
          if (!full) continue;
          const lines = full.split('\n').map((l) => l.trim()).filter(Boolean);

          // Repost marker: "<Name> ha/han compartido esto" / "reposted this".
          const REPOST = /\b(ha|han|he|hemos)\s+compartido esto|comparti[oó]\b|reposted this|shared this/i;
          const isRepost = REPOST.test(full.slice(0, 200));


          // Reactions come in two shapes: "83 reacciones" on most cards, or — when
          // people you know reacted (always the case on your own posts) — "Ana
          // Vázquez y 41 personas más han reaccionado", which means 42.
          let reactionsN: number | null = null;
          const rm = full.match(/([\d.]+(?:\s*mil)?)\s*(?:reacciones|reactions)\b/i);
          if (rm) {
            reactionsN = parseCount(rm[1]);
          } else {
            const om = full.match(/^(.+?)\s+(?:y|and)\s+([\d.]+(?:\s*mil)?)\s+(?:personas?\s+más|others?)/im);
            if (om) {
              reactionsN = (parseCount(om[2]) ?? 0) + om[1].split(',').length;
            } else {
              const nm = full.match(/^(.+?)\s+(?:ha|han)\s+reaccionado|^(.+?)\s+reacted/im);
              if (nm) reactionsN = (nm[1] ?? nm[2]).split(/,|\s+y\s+|\s+and\s+/).length;
            }
          }
          let comments: string | number | null | undefined = (full.match(/([\d.]+(?:\s*mil)?)\s*(?:comentarios|comments)/i) ?? [])[1];
          let reposts: string | number | null | undefined = (full.match(/([\d.]+)\s*(?:vez|veces)\s+compartid[oa]|([\d.]+)\s*reposts?\b/i) ?? []).slice(1).find(Boolean);

          // Since Oct 2026 the counts are bare numbers inside the action buttons
          // (reaction / Comentar / Compartir), identified only by aria-label.
          for (const btn of Array.from(card.querySelectorAll<HTMLElement>('button[aria-label]'))) {
            const n = (btn.innerText ?? '').trim();
            if (!/^[\d.,]+(\s*mil|k)?$/i.test(n)) continue;
            const label = btn.getAttribute('aria-label') ?? '';
            if (/reacci|reaction|recomendar|like/i.test(label)) reactionsN ??= parseCount(n);
            else if (/^(comentar|comment)/i.test(label)) comments ??= n;
            else if (/^(compartir|repost|share|volver a publicar)/i.test(label)) reposts ??= n;
          }
          // Impressions only render on the viewer's own posts ("3,444 impresiones").
          const impressions = (full.match(/([\d.,]+(?:\s*mil)?)\s*(?:impresiones|impressions)/i) ?? [])[1];

          // Body: strip the card chrome (feed label, repost header, author name/
          // headline, date, "Seguir", translation + engagement/CTA footer) and keep
          // the actual post text. We drop everything up to the date line, which
          // sits right before the body on LinkedIn update cards.
          // Date line: relative ("4 d", "2 sem", "3 h") on recent posts, absolute
          // ("24 de sept.", "Sep 24", "3 de mar. de 2025") on older ones.
          const DATE = /^(\d+\s*(?:min|h|d|sem|semanas?|mes(?:es)?|años?|yr|w|mo)\b|\d{1,2}\s+(?:de\s+)?[a-zé]{3,5}\.?(?:\s+(?:de\s+)?\d{4})?$|[A-Z][a-z]{2}\s+\d{1,2}(?:,\s*\d{4})?$)/i;
          const dateIdx = lines.findIndex((l) => DATE.test(l));
          const age = dateIdx >= 0 ? lines[dateIdx].replace(/\s*•.*$/, '').trim() : null;
          const afterDate = dateIdx >= 0 ? lines.slice(dateIdx + 1) : lines;
          const bodyLines = afterDate.filter((l) =>
            !/^(publicaci[oó]n en el feed|seguir|follow|conectar|connect|ver traducci[oó]n|mostrar traducci[oó]n|see translation|\.{3}\s*más|…\s*más|más|ver más|see more)$/i.test(l) &&
            !REPOST.test(l) &&
            !/^(ir al sitio web|visit|visitar)/i.test(l) &&
            !/^([\d.,]+(?:\s*mil)?\s*(reacciones|reactions|comentarios|comments|veces compartido|reposts?|impresiones|impressions))$/i.test(l) &&
            !/^(ver estad[ií]sticas|ver an[aá]lisis|view analytics|estad[ií]sticas)/i.test(l) &&
            !/\b(ha|han)\s+reaccionado$|personas?\s+más$|^•$/i.test(l) &&
            !/^[\d.]+\s*(vez|veces)\s+compartid[oa]$/i.test(l) &&
            !/^(recomendar|comentar|compartir|enviar|like|comment|share|send|me gusta)$/i.test(l),
          );
          // The action-button counts render as bare numbers right after the body.
          while (bodyLines.length && /^[\d.,]+(\s*mil|k)?$/i.test(bodyLines[bodyLines.length - 1])) bodyLines.pop();
          const body = bodyLines.join('\n').trim();

          // Attachment type. Photos render as large <img alt="Ver imagen|View image">,
          // videos as a <video> element (whose poster img has no alt), documents
          // (PDF carousels) carry a "document" aria-label.
          const labels = Array.from(card.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label') ?? '');
          const photos = Array.from(card.querySelectorAll('img')).filter(
            (i) => i.getBoundingClientRect().width >= 200 && /ver imagen|view image|image/i.test(i.getAttribute('alt') ?? ''),
          ).length;
          const media = card.querySelector('video') ? 'video'
            : labels.some((l) => /documento|document|carrusel|carousel/i.test(l)) ? 'document'
            : photos > 1 ? 'images' : photos === 1 ? 'image' : 'text';
          // C2PA "content credentials" badge — LinkedIn shows it on AI-generated images.
          const contentCredentials = labels.some((l) => /credenciales|content credentials/i.test(l));

          out.push({
            type: isRepost ? 'repost' : 'post',
            text: full.slice(0, 3000),
            body: body.slice(0, 3000),
            age,
            reactions: reactionsN,
            comments: comments ? parseCount(String(comments)) : null,
            reposts: reposts ? parseCount(String(reposts)) : null,
            impressions: impressions ? parseCount(impressions) : null,
            media,
            contentCredentials,
          });
        }
        return { posts: out, followers, name, headline };
      }, limit);

      const posts: ActivityPost[] = result.posts.map((p: any) => ({ ...p, days: this.ageToDays(p.age) }));
      return { posts, followers: result.followers, name: result.name, headline: result.headline };
    } finally {
      await page.close();
    }
  }

  /** "4 d" → 4, "2 sem" → 14, "3 meses" → 90, "1 año" → 365, "5 h" → 0. */
  private ageToDays(age: string | null): number | null {
    if (!age) return null;
    const abs = this.absoluteDateToDays(age);
    if (abs !== null) return abs;
    const m = age.match(/(\d+)\s*(min|h|d|sem|semanas?|mes(?:es)?|años?|w|mo|yr)/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const u = m[2].toLowerCase();
    if (u.startsWith('min') || u === 'h') return 0;
    if (u === 'd') return n;
    if (u.startsWith('sem') || u === 'w') return n * 7;
    if (u.startsWith('mes') || u === 'mo') return n * 30;
    if (u.startsWith('añ') || u === 'yr') return n * 365;
    return null;
  }

  /** "24 de sept.", "3 de mar. de 2025", "Sep 24", "Mar 3, 2025" → days ago */
  private absoluteDateToDays(age: string): number | null {
    const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    const EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const es = age.match(/^(\d{1,2})\s+(?:de\s+)?([a-zé]{3,5})\.?(?:\s+(?:de\s+)?(\d{4}))?$/i);
    const en = age.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?$/i);
    let day: number, month: number, year: number | null;
    if (es) {
      day = +es[1]; month = MONTHS.indexOf(es[2].toLowerCase().slice(0, 3)); year = es[3] ? +es[3] : null;
    } else if (en) {
      day = +en[2]; month = EN.indexOf(en[1].toLowerCase()); year = en[3] ? +en[3] : null;
    } else return null;
    if (month < 0) return null;
    const now = new Date();
    let d = new Date(year ?? now.getFullYear(), month, day);
    if (year === null && d > now) d = new Date(now.getFullYear() - 1, month, day); // no year shown = last 12 months
    return Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86_400_000));
  }

  /**
   * Scrape the comments a person has left on others' posts — the most candid
   * signal of what they care about and what frustrates them (people are far more
   * honest commenting than posting). Reads /recent-activity/comments/.
   *
   * Each card is a [componentkey^="update-card-focus"]; the person's own comment
   * lives in a [componentkey^="CommentComponentReference"] inside it, and its body
   * is the text right after the "Seguir/Connect" button in the comment header.
   */
  async getComments(slug: string, limit = 10): Promise<ActivityComment[]> {
    await this.session.ensureAuthenticated();
    const page = await this.browser.newPage();
    try {
      await page.goto(
        `https://www.linkedin.com/in/${slug}/recent-activity/comments/`,
        { waitUntil: 'domcontentloaded', timeout: 25000 },
      );
      await this.delay(3000, 4000);

      let last = 0;
      for (let i = 0; i < 12; i++) {
        const count = await page
          .$$eval('[componentkey^="update-card-focus"]', (els) => els.length)
          .catch(() => 0);
        if (count >= limit) break;
        if (count === last && i > 2) break;
        last = count;
        await page.evaluate(() => window.scrollBy(0, 1400));
        await this.delay(1000, 1500);
      }

      const comments: ActivityComment[] = await page.evaluate((max) => {
        const FOLLOW = /^(seguir|conectar|siguiendo|follow|connect|following)$/i;
        const TIME = /^\(?(editado|edited)?\)?\s*\d+\s*(min|h|d|sem|mes(?:es)?|años?|w|mo|yr)/i;
        const STOP = /^(…|\.{3}).*(más|more)$|^(me gusta|like|responder|reply|cargar más|load more|ver más|mostrar traducci[oó]n|show translation)$|^\d+\s*(reacci|reaction|respuesta|repl)/i;

        const cards = Array.from(document.querySelectorAll<HTMLElement>('[componentkey^="update-card-focus"]'));
        const out: any[] = [];
        for (const card of cards) {
          if (out.length >= max) break;
          // The card can show other people's comments too (e.g. when the person
          // replied on a thread), so pick the comment signed by the person named
          // in the card header ("<Name> han comentado" / "<Name> commented").
          const header = (card.innerText ?? '').split('\n').map((l) => l.trim()).find((l) => /\s(ha|han) comentado|\scommented/i.test(l));
          const who = header ? header.replace(/\s+(ha|han) comentado.*$|\s+commented.*$/i, '').trim() : null;
          let candidates = Array.from(card.querySelectorAll<HTMLElement>('[componentkey^="CommentComponentReference"]'));
          if (!candidates.length) candidates = Array.from(card.querySelectorAll<HTMLElement>('[componentkey^="replaceableComment_urn"]'));
          const byWho = who
            ? candidates.filter((el) => (el.innerText ?? '').split('\n').slice(0, 4).some((l) => l.trim().startsWith(who)))
            : candidates;
          const cmtEl = byWho[byWho.length - 1];
          if (!cmtEl) continue;

          const clines = (cmtEl.innerText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
          // comment body starts after the follow button (or after the time line).
          let start = clines.findIndex((l) => FOLLOW.test(l));
          if (start === -1) {
            const t = clines.findIndex((l) => TIME.test(l));
            start = t >= 0 ? t : 4;
          }
          const body: string[] = [];
          for (let i = start + 1; i < clines.length; i++) {
            const l = clines[i];
            if (STOP.test(l) || /^\d+$/.test(l)) break;
            body.push(l);
          }
          const comment = body.join(' ').trim();
          if (!comment) continue;

          const timeLine = clines.find((l) => TIME.test(l));
          const age = timeLine ? timeLine.replace(/^\(?(editado|edited)\)?\s*/i, '').trim() : null;

          // Context: the post they commented on (author + short snippet).
          const cardLines = (card.innerText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
          const hdr = cardLines.findIndex((l) => /han comentado|comment(ed|ó)|han compartido/i.test(l));
          const onPostBy = hdr >= 0 && cardLines[hdr + 1] ? cardLines[hdr + 1] : null;

          const cs = card.querySelector<HTMLElement>('[componentkey^="commentsSectionContainer"]');
          const csFirst = cs ? ((cs.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? null) : null;
          let postPart = cardLines;
          if (csFirst) { const ci = cardLines.indexOf(csFirst); if (ci > 0) postPart = cardLines.slice(0, ci); }
          const fb = postPart.findIndex((l) => FOLLOW.test(l));
          const onPost = (fb >= 0 ? postPart.slice(fb + 1) : postPart.slice(5))
            .join(' ').replace(/\s+/g, ' ').trim().slice(0, 220) || null;

          out.push({ comment: comment.slice(0, 1000), onPostBy, onPost, age, onOwnPost: !!who && onPostBy === who });
        }
        return out;
      }, limit);

      this.logger.log(`Comments for ${slug}: ${comments.length}`);
      return comments;
    } finally {
      await page.close();
    }
  }

  private delay(min: number, max: number) {
    return new Promise((r) => setTimeout(r, Math.random() * (max - min) + min));
  }
}
