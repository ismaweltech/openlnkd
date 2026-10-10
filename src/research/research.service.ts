import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ActivityPost, PeopleService, ProfileSummary } from '../people/people.service';
import { SessionService } from '../session/session.service';

export type ResearchJobType = 'audience' | 'benchmark' | 'voice';

export interface ResearchJob {
  id: string;
  type: ResearchJobType;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  params: any;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: { done: number; total: number; current: string | null };
  /** last log lines, newest last */
  log: string[];
  result: any;
  error: string | null;
}

export interface AudienceSegment {
  /** free label for the segment, e.g. "logistics / CFO" */
  label: string;
  /** people-search keywords, e.g. "director financiero logística" */
  keywords: string;
  location?: string;
  /** keep only people whose headline contains one of these (case-insensitive) */
  roleMatch?: string[];
}

export interface AudienceParams {
  segments: AudienceSegment[];
  /** profiles per segment (default 5) */
  perSegment?: number;
  /** posts per profile (default 5) */
  posts?: number;
  /** comments per profile (default 6, 0 to skip) */
  comments?: number;
}

export interface BenchmarkParams {
  /** profiles to benchmark directly */
  slugs?: string[];
  /** people-search keywords used to discover candidates */
  keywords?: string[];
  location?: string;
  /** regex a candidate's headline must match to count as relevant (case-insensitive) */
  headlineMatch?: string;
  /** max profiles to deep-analyse, explicit slugs included (default 25) */
  maxProfiles?: number;
  /** posts sampled per profile (default 8) */
  posts?: number;
  /** "active" = an own post in the last N days… (default 30) */
  activeDays?: number;
  /** …and at least this many own posts in the sample (default 3) */
  minOwnPosts?: number;
  /** add your own profile to the ranking for comparison (default true) */
  includeSelf?: boolean;
}

export interface VoiceParams {
  /** own posts to analyse (default 15) */
  posts?: number;
}

const DATA_DIR = join(process.env.RESEARCH_DIR ?? './data/research');
const LONE_SURROGATES = /[\ud800-\udfff]/g;

/**
 * Multi-profile research workflows built on top of PeopleService. Each one visits
 * many profiles, so it runs as a background job: POST returns a job id, GET
 * /research/jobs/:id reports progress and, when done, the result. Jobs run one at a
 * time (they share the browser) with a pause between profiles, and are saved under
 * data/research/ so results survive a restart.
 */
@Injectable()
export class ResearchService implements OnModuleInit {
  private readonly logger = new Logger(ResearchService.name);
  private readonly jobs = new Map<string, ResearchJob>();
  private queue: Promise<void> = Promise.resolve();
  private readonly delayMs = Number(process.env.RESEARCH_DELAY_MS ?? 2500);

  constructor(
    private readonly people: PeopleService,
    private readonly session: SessionService,
  ) {}

  onModuleInit() {
    mkdirSync(DATA_DIR, { recursive: true });
    for (const f of readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'))) {
      try {
        const job: ResearchJob = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'));
        if (job.status === 'queued' || job.status === 'running') {
          job.status = 'error';
          job.error = 'Interrupted by a server restart';
          this.save(job);
        }
        this.jobs.set(job.id, job);
      } catch {
        this.logger.warn(`Skipping unreadable research job file ${f}`);
      }
    }
  }

  // ── jobs ──────────────────────────────────────────────────────────────

  start(type: ResearchJobType, params: any): ResearchJob {
    const job: ResearchJob = {
      id: randomBytes(4).toString('hex'),
      type,
      status: 'queued',
      params,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: { done: 0, total: 0, current: null },
      log: [],
      result: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    this.save(job);
    this.queue = this.queue.then(() => this.run(job));
    return job;
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ result, log, ...rest }) => rest);
  }

  get(id: string): ResearchJob {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundException(`Research job ${id} not found`);
    return job;
  }

  cancel(id: string) {
    const job = this.get(id);
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      this.note(job, 'Cancelled');
    }
    return { id, status: job.status };
  }

  private async run(job: ResearchJob) {
    if (job.status === 'cancelled') return;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.save(job);
    try {
      const result =
        job.type === 'audience' ? await this.audience(job)
        : job.type === 'benchmark' ? await this.benchmark(job)
        : await this.voice(job);
      if (this.stopped(job)) return;
      job.result = result;
      job.status = 'done';
      this.note(job, 'Done');
    } catch (e: any) {
      if (this.stopped(job)) return;
      job.status = 'error';
      job.error = e?.message ?? String(e);
      this.note(job, `Error: ${job.error}`);
    } finally {
      job.finishedAt ??= new Date().toISOString();
      job.progress.current = null;
      this.save(job);
    }
  }

  // ── audience: what a target persona posts and comments ────────────────

  private async audience(job: ResearchJob) {
    const p: AudienceParams = job.params;
    if (!p?.segments?.length) throw new Error('segments is required');
    const perSegment = p.perSegment ?? 5;
    const nPosts = p.posts ?? 5;
    const nComments = p.comments ?? 6;
    job.progress.total = p.segments.length * perSegment;

    const segments: any[] = [];
    for (const seg of p.segments) {
      if (this.stopped(job)) break;
      this.note(job, `Searching "${seg.keywords}" (${seg.label})`);
      const found = await this.safe(job, () =>
        this.people.search({ keywords: seg.keywords, location: seg.location, limit: Math.max(15, perSegment * 3) }),
      );
      const match = (seg.roleMatch ?? []).map((r) => r.toLowerCase());
      const picked = (found ?? [])
        .filter((x) => !match.length || match.some((m) => (x.headline ?? '').toLowerCase().includes(m)))
        .slice(0, perSegment);
      this.note(job, `${found?.length ?? 0} results, ${picked.length} match the role`);
      job.progress.total -= perSegment - picked.length;

      const profiles: any[] = [];
      for (const person of picked) {
        if (this.stopped(job)) break;
        job.progress.current = person.id;
        const posts = (await this.safe(job, () => this.people.getActivity(person.id, nPosts))) ?? [];
        const comments = nComments
          ? (await this.safe(job, () => this.people.getComments(person.id, nComments))) ?? []
          : [];
        profiles.push({
          slug: person.id,
          name: person.name,
          headline: person.headline,
          company: (person as any).company ?? null,
          posts,
          comments,
        });
        this.tick(job, `${person.id}: ${posts.length} posts, ${comments.length} comments`);
        await this.pause();
      }
      segments.push({ ...seg, profiles });
    }

    const all = segments.flatMap((s) => s.profiles);
    return {
      totals: {
        segments: segments.length,
        profiles: all.length,
        posts: all.reduce((n, x) => n + x.posts.length, 0),
        comments: all.reduce((n, x) => n + x.comments.length, 0),
      },
      segments,
    };
  }

  // ── benchmark: find and rank reference creators in a niche ────────────

  private async benchmark(job: ResearchJob) {
    const p: BenchmarkParams = job.params ?? {};
    if (!p.slugs?.length && !p.keywords?.length) throw new Error('Pass slugs and/or keywords');
    const maxProfiles = p.maxProfiles ?? 25;
    const activeDays = p.activeDays ?? 30;
    const minOwnPosts = p.minOwnPosts ?? 3;
    const relevant = p.headlineMatch ? new RegExp(p.headlineMatch, 'i') : null;
    const me = await this.safe(job, () => this.session.getMe());

    // 1. discover candidates: a profile found by several keywords ranks higher
    const hits = new Map<string, { slug: string; headline: string | null; hits: number }>();
    for (const kw of p.keywords ?? []) {
      if (this.stopped(job)) break;
      const found = (await this.safe(job, () => this.people.search({ keywords: kw, location: p.location, limit: 20 }))) ?? [];
      let added = 0;
      for (const x of found) {
        if (x.id === me?.slug || (relevant && !relevant.test(x.headline ?? ''))) continue;
        const c = hits.get(x.id) ?? { slug: x.id, headline: x.headline, hits: 0 };
        if (!c.hits) added++;
        c.hits++;
        hits.set(x.id, c);
      }
      this.note(job, `"${kw}": ${found.length} results, ${added} new relevant`);
      await this.pause();
    }

    const explicit = p.slugs ?? [];
    const discovered = [...hits.values()]
      .filter((c) => !explicit.includes(c.slug))
      .sort((a, b) => b.hits - a.hits)
      .map((c) => c.slug);
    const targets = [...explicit, ...discovered].slice(0, Math.max(maxProfiles, explicit.length));
    if (p.includeSelf !== false && me?.slug) targets.push(me.slug);
    job.progress.total = targets.length;
    this.note(job, `${hits.size} candidates, analysing ${targets.length}`);

    // 2. one profile visit each, then rank active profiles by median engagement
    const rows: any[] = [];
    for (const slug of targets) {
      if (this.stopped(job)) break;
      job.progress.current = slug;
      const prof = await this.safe(job, () => this.people.getProfile(slug, p.posts ?? 8));
      if (prof) rows.push(this.benchmarkRow(prof, slug === me?.slug, hits.get(slug)?.hits ?? 0, activeDays, minOwnPosts));
      this.tick(job, prof ? `${slug}: median ${prof.metrics.medianEngagement ?? '–'}, ${prof.followers ?? '?'} followers` : `${slug}: failed`);
      await this.pause();
    }

    rows.sort((a, b) => Number(b.active) - Number(a.active) || (b.medianEngagement ?? -1) - (a.medianEngagement ?? -1));
    return {
      candidates: hits.size,
      analysed: rows.length,
      active: rows.filter((r) => r.active && !r.you).length,
      criteria: { activeDays, minOwnPosts, metric: 'median reactions+comments over own posts' },
      ranking: rows,
    };
  }

  private benchmarkRow(prof: ProfileSummary, you: boolean, hits: number, activeDays: number, minOwnPosts: number) {
    const m = prof.metrics;
    const own = prof.posts.filter((x) => x.type === 'post');
    const best = [...own].sort((a, b) => this.engagement(b) - this.engagement(a))[0];
    return {
      slug: prof.slug,
      url: `https://www.linkedin.com/in/${prof.slug}/`,
      you,
      name: prof.name,
      headline: prof.headline,
      followers: prof.followers,
      medianEngagement: m.medianEngagement,
      /** median engagement per 100 followers — lets small and big accounts be compared */
      engagementRate: prof.followers && m.medianEngagement !== null
        ? Math.round((m.medianEngagement / prof.followers) * 10000) / 100
        : null,
      lastOwnPostDays: m.lastOwnPostDays,
      ownPostsLast30d: m.ownPostsLast30d,
      ownRatio: m.ownRatio,
      active: m.lastOwnPostDays !== null && m.lastOwnPostDays <= activeDays && m.ownPosts >= minOwnPosts,
      searchHits: hits,
      bestPost: best ? { engagement: this.engagement(best), age: best.age, excerpt: best.body.slice(0, 280) } : null,
    };
  }

  // ── voice: what already works on your own profile ─────────────────────

  private async voice(job: ResearchJob) {
    const p: VoiceParams = job.params ?? {};
    job.progress.total = 1;
    const me = await this.session.getMe();
    job.progress.current = me.slug;
    this.note(job, `Reading your last ${p.posts ?? 15} posts (${me.slug})`);
    const prof = await this.people.getProfile(me.slug, p.posts ?? 15);
    this.tick(job, `${prof.posts.length} posts read`);

    const own = prof.posts.filter((x) => x.type === 'post');
    const imps = own.map((x) => x.impressions).filter((n): n is number => n !== null);
    const summary = (x: ActivityPost) => ({
      age: x.age,
      impressions: x.impressions,
      engagement: this.engagement(x),
      excerpt: x.body.slice(0, 200),
    });
    const pct = (n: number) => (own.length ? Math.round((n / own.length) * 100) : null);
    const lines = own.map((x) => x.body.split('\n').filter((l) => l.trim()).length);
    const lastLine = (x: ActivityPost) => x.body.trim().split('\n').filter((l) => l.trim()).pop() ?? '';

    return {
      slug: me.slug,
      followers: prof.followers,
      ownPosts: own.length,
      medianEngagement: prof.metrics.medianEngagement,
      engagementRate: prof.followers && prof.metrics.medianEngagement !== null
        ? Math.round((prof.metrics.medianEngagement / prof.followers) * 10000) / 100
        : null,
      medianImpressions: this.median(imps),
      postsLast30d: prof.metrics.ownPostsLast30d,
      topByImpressions: [...own].filter((x) => x.impressions !== null)
        .sort((a, b) => b.impressions! - a.impressions!).slice(0, 3).map(summary),
      topByEngagement: [...own].sort((a, b) => this.engagement(b) - this.engagement(a)).slice(0, 3).map(summary),
      style: {
        medianChars: this.median(own.map((x) => x.body.length)),
        medianLines: this.median(lines),
        /** % of posts whose last line is a question */
        endsWithQuestion: pct(own.filter((x) => lastLine(x).trim().endsWith('?')).length),
        /** % of posts that ask something in their last three lines */
        questionNearEnd: pct(own.filter((x) => x.body.trim().split('\n').filter((l) => l.trim()).slice(-3).some((l) => l.includes('?'))).length),
        withEmoji: pct(own.filter((x) => /\p{Extended_Pictographic}/u.test(x.body)).length),
        withNumbers: pct(own.filter((x) => /\d/.test(x.body)).length),
        withLink: pct(own.filter((x) => /https?:\/\/|lnkd\.in/.test(x.body)).length),
        /** how each post closes — the sign-off is a big part of a voice */
        closings: own.map(lastLine),
      },
      posts: own,
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private engagement(x: ActivityPost) {
    return (x.reactions ?? 0) + (x.comments ?? 0);
  }

  private median(xs: number[]): number | null {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }

  /** run a step; on failure log it and carry on with the next profile */
  private async safe<T>(job: ResearchJob, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e: any) {
      this.note(job, `Warning: ${e?.message ?? e}`);
      return null;
    }
  }

  private stopped(job: ResearchJob) {
    return job.status === 'cancelled';
  }

  private pause() {
    return new Promise((r) => setTimeout(r, this.delayMs));
  }

  private tick(job: ResearchJob, msg: string) {
    job.progress.done++;
    this.note(job, `[${job.progress.done}/${job.progress.total}] ${msg}`);
  }

  private note(job: ResearchJob, msg: string) {
    this.logger.log(`[${job.type} ${job.id}] ${msg}`);
    job.log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
    if (job.log.length > 50) job.log.shift();
    this.save(job);
  }

  /** atomic write; strips lone surrogates that sliced emoji text can leave behind */
  private save(job: ResearchJob) {
    const file = join(DATA_DIR, `${job.id}.json`);
    const json = JSON.stringify(job, (_k, v) => (typeof v === 'string' ? v.replace(LONE_SURROGATES, '') : v));
    writeFileSync(`${file}.tmp`, json);
    renameSync(`${file}.tmp`, file);
  }
}

