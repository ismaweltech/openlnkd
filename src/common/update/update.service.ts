import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

const GITHUB_REPO = 'ismaweltech/openlnkd';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

export interface VersionInfo {
  current: string;
  latest: string | null;
  upToDate: boolean | null; // null = could not determine (offline, no releases, disabled)
  releaseUrl: string;
}

/**
 * Checks GitHub for a newer published release on startup and via GET /version.
 *
 * Privacy: this only performs a public, unauthenticated GET to GitHub's
 * releases API. It sends NO information about the user, the machine, or usage —
 * it is the user asking GitHub "what's the latest version", nothing more.
 * Disable entirely with UPDATE_CHECK=false.
 *
 * It never blocks or crashes startup: any network/parse error fails silently.
 */
@Injectable()
export class UpdateService implements OnApplicationBootstrap {
  private readonly logger = new Logger(UpdateService.name);
  private readonly current: string = this.readCurrentVersion();
  private readonly enabled: boolean = process.env.UPDATE_CHECK !== 'false';
  private latest: string | null = null;

  async onApplicationBootstrap() {
    if (!this.enabled) return;
    // Fire-and-forget: don't hold up boot waiting on the network.
    void this.check();
  }

  /** Returns cached/fresh version info for the /version endpoint. */
  async getVersionInfo(): Promise<VersionInfo> {
    if (this.enabled && this.latest === null) {
      await this.check();
    }
    return {
      current: this.current,
      latest: this.latest,
      upToDate: this.latest ? !this.isNewer(this.latest, this.current) : null,
      releaseUrl: `https://github.com/${GITHUB_REPO}/releases`,
    };
  }

  private async check(): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openlnkd' },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!res.ok) return; // e.g. 404 when no releases exist yet — stay quiet

      const data: any = await res.json();
      const tag: string = (data?.tag_name ?? '').replace(/^v/, '');
      if (!tag) return;
      this.latest = tag;

      if (this.isNewer(tag, this.current)) {
        this.logger.warn(
          `Update available: v${tag} (you're on v${this.current}). ` +
          `LinkedIn changes often — update with: git pull && docker compose up -d --build`,
        );
        this.logger.warn(`Release notes: https://github.com/${GITHUB_REPO}/releases`);
      }
    } catch {
      // Offline, timeout, rate-limited, malformed — never surface as an error.
    }
  }

  /** True when semver `a` is strictly greater than `b` (numeric-only, missing parts = 0). */
  private isNewer(a: string, b: string): boolean {
    const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
    const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] ?? 0;
      const y = pb[i] ?? 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  }

  private readCurrentVersion(): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('../../../package.json').version ?? '0.0.0';
    } catch {
      return '0.0.0';
    }
  }
}
