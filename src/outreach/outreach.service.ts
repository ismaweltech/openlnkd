import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BrowserService } from '../common/browser/browser.service';
import { DatabaseService } from '../common/database/database.service';
import { MessengerService } from '../common/messaging/messenger.service';
import { SessionService } from '../session/session.service';
import { VoyagerService } from '../common/voyager/voyager.service';
import { TemplatesService } from '../templates/templates.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';

export { CreateCampaignDto } from './dto/create-campaign.dto';

export interface Campaign {
  id: number;
  name: string;
  template_id: number;
  status: 'pending' | 'running' | 'done' | 'error';
  total: number;
  sent: number;
  failed: number;
  delay_min: number;
  delay_max: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  targets?: CampaignTarget[];
}

export interface CampaignTarget {
  id: number;
  campaign_id: number;
  profile_url: string;
  name: string | null;
  status: 'pending' | 'sent' | 'failed';
  message_sent: string | null;
  error: string | null;
  sent_at: string | null;
}

export interface InboxMessage {
  senderName: string;
  senderUrl: string;
  preview: string;
  timestamp: string | null;
  unread: boolean;
}

@Injectable()
export class OutreachService {
  private readonly logger = new Logger(OutreachService.name);

  constructor(
    private readonly browser: BrowserService,
    private readonly db: DatabaseService,
    private readonly messenger: MessengerService,
    private readonly session: SessionService,
    private readonly voyager: VoyagerService,
    private readonly templates: TemplatesService,
  ) {}

  // ─── Campaigns ────────────────────────────────────────────────────────────

  async createCampaign(dto: CreateCampaignDto): Promise<Campaign> {
    await this.templates.findOne(dto.templateId); // validates template exists

    const result = await this.db.execute(
      `INSERT INTO campaigns (name, template_id, total, delay_min, delay_max, filter_connections)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        dto.name, dto.templateId, dto.profileUrls.length,
        dto.delayMin ?? 30, dto.delayMax ?? 90,
        dto.filterConnections ? 1 : 0,
      ],
    );

    const campaignId = result.lastInsertRowid!;

    // Insert targets
    for (const url of dto.profileUrls) {
      await this.db.execute(
        'INSERT INTO campaign_targets (campaign_id, profile_url) VALUES (?, ?)',
        [campaignId, url],
      );
    }

    this.logger.log(`Campaign "${dto.name}" created with ${dto.profileUrls.length} targets`);
    return this.findCampaign(campaignId);
  }

  async runCampaign(campaignId: number): Promise<{
    ok: boolean; sent: number; failed: number; skipped: number;
  }> {
    await this.session.ensureAuthenticated();
    const campaign = await this.findCampaign(campaignId);

    if (campaign.status === 'running') {
      return { ok: false, sent: 0, failed: 0, skipped: 0 };
    }

    const filterConnections = (campaign as any).filter_connections === 1;

    await this.db.execute(
      `UPDATE campaigns SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [campaignId],
    );

    const targets = await this.db.query<CampaignTarget>(
      `SELECT * FROM campaign_targets WHERE campaign_id = ? AND status = 'pending'`,
      [campaignId],
    );

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const target of targets) {
      try {
        // ── Scrape profile (name + connection status) ──────────────────────
        const profileData = await this.scrapeProfileName(target.profile_url);

        // Save connection status on the target
        await this.db.execute(
          `UPDATE campaign_targets SET name = ?, is_connection = ? WHERE id = ?`,
          [profileData.name, profileData.isConnection ? 1 : 0, target.id],
        );

        // ── Filter: skip if not a 1st-degree connection ────────────────────
        if (filterConnections && !profileData.isConnection) {
          await this.db.execute(
            `UPDATE campaign_targets SET status = 'skipped', error = ? WHERE id = ?`,
            ['Not a 1st-degree connection', target.id],
          );
          skipped++;
          this.logger.log(`Skipped ${profileData.name} — not connected`);
          continue;
        }

        // ── Render template ────────────────────────────────────────────────
        const message = await this.templates.render(campaign.template_id, {
          name: profileData.firstName,
          fullName: profileData.name,
          company: profileData.company ?? '',
          title: profileData.headline ?? '',
        });

        // ── Send ───────────────────────────────────────────────────────────
        await this.sendMessageToProfile(target.profile_url, message);

        await this.db.execute(
          `UPDATE campaign_targets
           SET status = 'sent', message_sent = ?, sent_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [message, target.id],
        );

        sent++;
        this.logger.log(`[${sent}/${targets.length}] Sent to ${profileData.name}`);

        // ── Human delay between messages (seconds → ms) ────────────────────
        const delaySec =
          campaign.delay_min + Math.random() * (campaign.delay_max - campaign.delay_min);
        this.logger.debug(`Waiting ${Math.round(delaySec)}s before next message...`);
        await this.delay(delaySec * 1000);

      } catch (err: any) {
        failed++;
        await this.db.execute(
          `UPDATE campaign_targets SET status = 'failed', error = ? WHERE id = ?`,
          [err?.message ?? 'Unknown error', target.id],
        );
        this.logger.warn(`Failed for ${target.profile_url}: ${err?.message}`);
      }
    }

    await this.db.execute(
      `UPDATE campaigns
       SET status = 'done', sent = ?, failed = ?, finished_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [sent, failed, campaignId],
    );

    this.logger.log(`Campaign ${campaignId} done — sent: ${sent}, skipped: ${skipped}, failed: ${failed}`);
    return { ok: true, sent, failed, skipped };
  }

  async findAllCampaigns(): Promise<Campaign[]> {
    return this.db.query<Campaign>('SELECT * FROM campaigns ORDER BY created_at DESC');
  }

  async findCampaign(id: number): Promise<Campaign> {
    const row = await this.db.queryOne<any>('SELECT * FROM campaigns WHERE id = ?', [id]);
    if (!row) throw new NotFoundException(`Campaign ${id} not found`);
    const targets = await this.db.query<CampaignTarget>(
      'SELECT * FROM campaign_targets WHERE campaign_id = ?',
      [id],
    );
    return { ...row, targets };
  }

  // ─── Recruiter finder ─────────────────────────────────────────────────────

  async findJobRecruiter(jobId: string): Promise<{ name: string; profile_url: string; headline: string | null } | null> {
    await this.session.ensureAuthenticated();

    // ── Primary: extract from Voyager job posting JSON ────────────────────
    const data = await this.voyager.get(`jobs/jobPostings/${jobId}`, {
      decorationId: 'com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-14',
    });

    if (data) {
      const byUrn = this.voyager.buildUrnMap(data);
      const recruiter = this.extractRecruiterFromJobData(data?.data ?? data, byUrn);
      if (recruiter) {
        this.logger.log(`Recruiter found via API for job ${jobId}: ${recruiter.name}`);
        return recruiter;
      }
    }

    // ── Fallback: browser scraping ────────────────────────────────────────
    this.logger.log(`Recruiter API miss for ${jobId} — opening browser`);
    return this.findJobRecruiterViaBrowser(jobId);
  }

  private extractRecruiterFromJobData(
    data: any,
    byUrn: Map<string, any>,
  ): { name: string; profile_url: string; headline: string | null } | null {
    // Field name varies by decoration — walk common locations
    const walk = (obj: any, depth = 0): any => {
      if (!obj || typeof obj !== 'object' || depth > 6) return null;
      const keys = ['hiringTeam', 'jobPoster', 'recruiter', 'poster', 'hiringManager'];
      for (const k of keys) {
        if (obj[k]) return obj[k];
      }
      for (const v of Object.values(obj)) {
        const found = walk(v, depth + 1);
        if (found) return found;
      }
      return null;
    };

    const recruiterRef = walk(data);
    if (!recruiterRef) return null;

    // Resolve URN if it's a string reference
    const resolved = typeof recruiterRef === 'string' ? byUrn.get(recruiterRef) : recruiterRef;
    if (!resolved) return null;

    const slug =
      resolved.publicIdentifier ??
      resolved.miniProfile?.publicIdentifier ??
      (resolved.entityUrn ?? '').split(':').pop();

    const firstName = resolved.firstName ?? resolved.miniProfile?.firstName ?? '';
    const lastName = resolved.lastName ?? resolved.miniProfile?.lastName ?? '';
    const name = [firstName, lastName].filter(Boolean).join(' ');
    if (!name || !slug) return null;

    return {
      name,
      profile_url: `https://www.linkedin.com/in/${slug}`,
      headline: resolved.headline ?? resolved.miniProfile?.occupation ?? null,
    };
  }

  private async findJobRecruiterViaBrowser(
    jobId: string,
  ): Promise<{ name: string; profile_url: string; headline: string | null } | null> {
    const page = await this.browser.newPage();
    try {
      await page.goto(`https://www.linkedin.com/jobs/view/${jobId}/`, {
        waitUntil: 'domcontentloaded', timeout: 20000,
      });
      await this.delay(2000, 3000);
      await page.evaluate(() => window.scrollBy(0, 600));
      await this.delay(1000, 1500);

      const linkEl = await page.$('[class*="hirer-card"] a[href*="/in/"], .job-poster a[href*="/in/"]');
      if (!linkEl) return null;

      const href = await linkEl.getAttribute('href');
      const profile_url =
        'https://www.linkedin.com' +
        (href ?? '').split('?')[0].replace('https://www.linkedin.com', '');
      const name = await linkEl.textContent().then((t: string) => t?.trim() ?? '').catch(() => '');
      const headlineEl = await page.$('[class*="hirer-card"] [class*="subtitle"], [class*="hirer-card"] .text-body-small');
      const headline = headlineEl
        ? await headlineEl.textContent().then((t: string) => t?.trim()).catch(() => null)
        : null;

      return { name, profile_url, headline };
    } finally {
      await page.close();
    }
  }

  async messageJobRecruiter(
    jobId: string,
    templateId: number,
    extraVars: Record<string, string> = {},
  ): Promise<{ ok: boolean; message: string }> {
    const recruiter = await this.findJobRecruiter(jobId);
    if (!recruiter) {
      return { ok: false, message: 'Recruiter not found for this job' };
    }

    const firstName = recruiter.name.split(' ')[0];
    const rendered = await this.templates.render(templateId, {
      name: firstName,
      fullName: recruiter.name,
      title: recruiter.headline ?? '',
      ...extraVars,
    });

    await this.sendMessageToProfile(recruiter.profile_url, rendered);
    return { ok: true, message: `Message sent to ${recruiter.name}` };
  }

  // ─── Inbox ────────────────────────────────────────────────────────────────

  async readInbox(limit = 20): Promise<InboxMessage[]> {
    await this.session.ensureAuthenticated();

    // ── Primary: Voyager messaging conversations API ───────────────────────
    const data = await this.voyager.get('messaging/conversations', {
      keyVersion: 'LEGACY_INBOX',
      q: 'inbox',
      count: String(limit),
    });

    if (data) {
      const messages = this.parseInboxResponse(data, limit);
      if (messages.length > 0) {
        this.logger.log(`Inbox API → ${messages.length} conversations`);
        return messages;
      }
    }

    // ── Fallback: browser scraping ────────────────────────────────────────
    this.logger.log(`Inbox API miss — opening browser`);
    return this.readInboxViaBrowser(limit);
  }

  private parseInboxResponse(data: any, limit: number): InboxMessage[] {
    const messages: InboxMessage[] = [];
    const byUrn = this.voyager.buildUrnMap(data);
    const elements: any[] = data?.data?.elements ?? data?.elements ?? [];

    for (const conv of elements.slice(0, limit)) {
      try {
        // Participants (skip self)
        const participants: any[] = conv.conversationParticipants ?? conv.participants ?? [];
        const other = participants.find((p: any) => {
          const m = p?.participantType?.member ?? p?.member ?? p;
          return m && !m.distance?.value?.includes('SELF');
        });
        const member = other?.participantType?.member ?? other?.member ?? other ?? {};
        const firstName = member?.firstName ?? '';
        const lastName = member?.lastName ?? '';
        const senderName = [firstName, lastName].filter(Boolean).join(' ') ||
          member?.miniProfile?.firstName + ' ' + member?.miniProfile?.lastName ||
          'Unknown';

        const slug = member?.publicIdentifier ?? member?.miniProfile?.publicIdentifier ?? '';
        const senderUrl = slug ? `https://www.linkedin.com/in/${slug}` : '';

        // Last event = message preview
        const events: any[] = conv.events ?? [];
        const lastEvent = events[0];
        const msgEvent =
          lastEvent?.eventContent?.['com.linkedin.voyager.messaging.event.MessageEvent'] ??
          Object.values(lastEvent?.eventContent ?? {}).find((v: any) => v?.body) as any;
        const preview: string = msgEvent?.body ?? msgEvent?.subject ?? '';

        const timestamp = conv.lastActivityAt
          ? new Date(conv.lastActivityAt).toISOString()
          : null;
        const unread = (conv.unreadCount ?? 0) > 0;

        if (senderName && senderName !== 'Unknown') {
          messages.push({ senderName, senderUrl, preview, timestamp, unread });
        }
      } catch { /* skip malformed */ }
    }

    return messages;
  }

  private async readInboxViaBrowser(limit: number): Promise<InboxMessage[]> {
    const page = await this.browser.newPage();
    const messages: InboxMessage[] = [];

    try {
      await page.goto('https://www.linkedin.com/messaging/', {
        waitUntil: 'domcontentloaded', timeout: 20000,
      });
      await this.delay(3000, 4000);

      const conversations = await page.$$('.msg-conversation-listitem, [class*="msg-conversation-listitem"]');
      for (const conv of conversations.slice(0, limit)) {
        try {
          const nameEl = await conv.$('.msg-conversation-listitem__participant-names, [class*="participant-names"]');
          const name = await nameEl?.textContent().then((t: string) => t?.trim() ?? '').catch(() => '') ?? '';
          const linkEl = await conv.$('a[href*="/messaging/"]');
          const href = await linkEl?.getAttribute('href').catch(() => null);
          const senderUrl = href ? `https://www.linkedin.com${href}` : '';
          const previewEl = await conv.$('.msg-conversation-listitem__message-snippet, [class*="message-snippet"]');
          const preview = await previewEl?.textContent().then((t: string) => t?.trim() ?? '').catch(() => '') ?? '';
          const timeEl = await conv.$('time, [class*="timestamp"]');
          const timestamp = await timeEl?.getAttribute('datetime').catch(() => null) ?? null;
          const unreadEl = await conv.$('[class*="notification-badge"], [class*="unread"]');
          const unread = !!unreadEl;
          if (name) messages.push({ senderName: name, senderUrl, preview, timestamp, unread });
        } catch { /* skip */ }
      }
    } finally {
      await page.close();
    }

    return messages;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async scrapeProfileName(profileUrl: string): Promise<{
    name: string;
    firstName: string;
    headline: string | null;
    company: string | null;
    isConnection: boolean;
  }> {
    const slug = profileUrl.match(/\/in\/([^/?]+)/)?.[1] ?? '';

    // ── Primary: Voyager identity/profiles API ────────────────────────────
    if (slug) {
      const data = await this.voyager.get(`identity/profiles/${slug}`);
      if (data) {
        const profile = data?.data ?? data;
        const firstName: string = profile.firstName ?? profile.miniProfile?.firstName ?? '';
        const lastName: string = profile.lastName ?? profile.miniProfile?.lastName ?? '';
        const name = [firstName, lastName].filter(Boolean).join(' ');

        if (name && !name.toLowerCase().includes('linkedin')) {
          const headline: string | null = profile.headline ?? null;
          const company = headline?.match(/(?:at|@|en)\s+(.+)/i)?.[1]?.trim() ?? null;

          // DISTANCE_1 = 1st degree = connected
          const distanceVal: string =
            profile.miniProfile?.distance?.value ??
            profile.distance?.value ?? '';
          const isConnection = distanceVal.includes('1');

          this.logger.debug(`Profile API: ${name} — distance: ${distanceVal}`);
          return { name, firstName: name.split(' ')[0], headline, company, isConnection };
        }
      }
    }

    // ── Fallback: browser ─────────────────────────────────────────────────
    this.logger.debug(`Profile API miss for ${slug} — opening browser`);
    return this.scrapeProfileNameViaBrowser(profileUrl, slug);
  }

  private async scrapeProfileNameViaBrowser(profileUrl: string, slug: string): Promise<{
    name: string; firstName: string; headline: string | null; company: string | null; isConnection: boolean;
  }> {
    const page = await this.browser.newPage();
    try {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this.delay(2000, 3000);

      const PRIVACY = ['linkedin respeta tu privacidad', 'linkedin member', 'linkedin'];
      let name = await page.$eval('h1', (el: Element) => el.textContent?.trim() ?? '').catch(() => '');
      if (!name || PRIVACY.some((p) => name.toLowerCase().includes(p))) {
        name = await page.$eval('meta[property="og:title"]', (el) => el.getAttribute('content') ?? '').catch(() => '');
      }
      // Fallback: the page <title> is reliably "Nombre Apellidos | LinkedIn"
      if (!name || PRIVACY.some((p) => name.toLowerCase().includes(p))) {
        const title = await page.title().catch(() => '');
        name = title.replace(/\s*\|\s*LinkedIn.*$/i, '').trim();
      }
      if (!name || PRIVACY.some((p) => name.toLowerCase().includes(p))) {
        name = slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }

      const headline = await page
        .$eval('.text-body-medium.break-words', (el: Element) => el.textContent?.trim() ?? '')
        .catch(() => null);
      const company = headline?.match(/(?:at|@|en)\s+(.+)/i)?.[1]?.trim() ?? null;

      // Connection = 1st-degree. The profile shows a distance badge "· 1º" / "· 1er" /
      // "· 1st" next to the name. This is far more reliable than looking for a Message
      // button (which LinkedIn now renders as a plain <a>, breaking button-based checks).
      const isConnection = await page.evaluate(() => {
        const txt = document.body.innerText;
        return /·\s*(1[ºoª]|1st|1er)\b/i.test(txt);
      }).catch(() => false);

      return { name, firstName: name.split(' ')[0], headline, company, isConnection };
    } finally {
      await page.close();
    }
  }

  private async sendMessageToProfile(profileUrl: string, message: string): Promise<void> {
    // Delegates to MessengerService — the single implementation of "send a DM",
    // shared with /connections/message so LinkedIn UI changes are fixed in one place.
    const result = await this.messenger.sendMessage(profileUrl, message);
    if (!result.ok) throw new Error(result.message);
  }

  private delay(ms: number, max?: number) {
    const wait = max !== undefined ? ms + Math.random() * (max - ms) : ms;
    return new Promise((r) => setTimeout(r, wait));
  }
}
