import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface GateConfig {
  minVersion?: string;
  warnBelow?: string;
}

/** "1.4.2" style comparison; missing segments count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Minimum-version gate (docs/api-specification.md §1). Config comes from env
 * until the app_version_gate table ships with migration group 100:
 * APP_MIN_VERSION_IOS / APP_MIN_VERSION_ANDROID / APP_WARN_VERSION_*.
 * Requests without version headers pass — web and server-to-server callers.
 */
@Injectable()
export class VersionGateMiddleware implements NestMiddleware {
  constructor(private readonly config: ConfigService) {}

  private gateFor(platform: string): GateConfig {
    const key = platform.toUpperCase();
    return {
      minVersion: this.config.get<string>(`APP_MIN_VERSION_${key}`),
      warnBelow: this.config.get<string>(`APP_WARN_VERSION_${key}`),
    };
  }

  use(
    req: { headers: Record<string, string | string[] | undefined> },
    res: {
      setHeader(name: string, value: string): void;
      status(code: number): { json(body: unknown): void };
    },
    next: () => void,
  ): void {
    const platform = String(req.headers['x-app-platform'] ?? '');
    const version = String(req.headers['x-app-version'] ?? '');
    if (!platform || !version) return next();

    const gate = this.gateFor(platform);
    if (gate.minVersion && compareVersions(version, gate.minVersion) < 0) {
      res.status(426).json({
        type: 'about:blank',
        title: 'Upgrade Required',
        status: 426,
        code: 'app_version_unsupported',
        detail: `App builds below ${gate.minVersion} are no longer supported.`,
        min_version: gate.minVersion,
      });
      return;
    }
    if (gate.warnBelow && compareVersions(version, gate.warnBelow) < 0) {
      res.setHeader('X-Upgrade-Advised', gate.warnBelow);
    }
    next();
  }
}
