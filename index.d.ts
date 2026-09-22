export interface WatchdogOptions {
  /**
   * Runs a trivial command on the SHARED client the requests use. A separate
   * connection is exactly the thing that stays healthy while readers get
   * nothing, so a probe built on one reports everything fine during the outage
   * it is meant to catch.
   */
  probe: (signal: AbortSignal) => Promise<unknown>;
  /** What is being watched: "the database pool", "redis". Name the client, not the server. */
  subject?: string;
  /** Gap between probes. Default 30_000. */
  intervalMs?: number;
  /** How long one probe may take before it counts as a failure. Default 10_000. */
  timeoutMs?: number;
  /** Consecutive failures before giving up. Default 3. */
  failures?: number;
  /** What to do when the client is declared gone. Default `process.exit(1)`. */
  onGiveUp?: (reason: string) => void;
  log?: { error?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
}

export interface Watchdog {
  /** Run one probe now. Resolves true if the client answered inside the timeout. */
  check: () => Promise<boolean>;
  stop: () => void;
  subject: string;
}

export interface WatchdogGroup {
  watchdogs: Watchdog[];
  /** Stops all of them. Call this FIRST on shutdown, before closing the clients. */
  stop: () => void;
  check: () => Promise<boolean[]>;
}

export declare const DEFAULT_FAILURES: number;
export declare const DEFAULT_INTERVAL_MS: number;
export declare const DEFAULT_TIMEOUT_MS: number;

export declare function startWatchdog(options: WatchdogOptions): Watchdog;
export declare function startWatchdogs(
  specs: WatchdogOptions[],
  shared?: Partial<WatchdogOptions>,
): WatchdogGroup;

export interface WatchDependenciesOptions {
  /** Resolves truthy when the pool is well. Usually your existing `healthcheck()`. */
  postgres?: () => Promise<unknown>;
  /** Resolves 'PONG' when the client is well. Usually `connection.ping()`. */
  redis?: () => Promise<string>;
  /** Where the knobs are read from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Applied OVER both specs, so anything named here wins, including the
   * timings. Naming `failures` flattens the extra rope Redis gets by default.
   */
  shared?: Partial<WatchdogOptions>;
}

/**
 * The pair almost every service needs, with the tuning already argued out:
 * `DB_WATCHDOG_*` and `REDIS_WATCHDOG_*` knobs, and one more permitted failure
 * for Redis because a healthy Redis is routinely unreachable while it reloads
 * its snapshot. Omit either probe and it is simply not watched.
 */
export declare function watchDependencies(options?: WatchDependenciesOptions): WatchdogGroup;
