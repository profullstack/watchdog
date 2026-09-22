/**
 * Notice when a dependency has stopped answering the client this process uses.
 *
 * Extracted from tipoffwatch and genrewatch after the same outage happened three
 * times on two sites, twice on Redis and once on a Postgres pool.
 *
 * The shape is always identical and always looks healthy from outside. On
 * 2026-09-07 every page on genrewatch hung forever while the container stayed up,
 * Postgres stayed healthy and the platform reported the service Online: the web
 * process had run about 29 hours and its connection pool had lost every slot it
 * had. A query issued from a request queued for a connection that was never going
 * to arrive, and the pool had no queue deadline, so the request never failed and
 * never answered. On 2026-09-13 and again on 2026-09-22, tipoffwatch did the same
 * thing on Redis: its shared ioredis client is built with
 * `maxRetriesPerRequest: null` because BullMQ requires it, and that turns a
 * disconnect into a hang rather than a rejection. Code written as "a Redis blip
 * must not take the site down" catches nothing, because there is no error to
 * catch.
 *
 * Every time, the health endpoint answered in milliseconds, because a health
 * endpoint that touches no dependency is measuring the wrong thing. Restarting
 * the datastore did not help either: the wedge is on the client side of the
 * socket, so only replacing the process recovered it, and every time a person had
 * to notice first.
 *
 * Two rules follow, and they are the whole reason this module exists.
 *
 * **The probe must go through the same client the requests use.** A separate
 * connection is exactly the thing that stayed healthy for 29 hours while readers
 * got nothing: a fresh pool opened inside that same container ran a real query in
 * 51ms. A watchdog built on its own connection would have reported everything
 * fine throughout.
 *
 * **The timeout must be a race, not a driver option.** The symptom is a promise
 * that never settles at all, so awaiting the command alone hangs the watchdog in
 * precisely the case it exists for.
 *
 * What it does when it decides the client is gone is exit. That reads as drastic
 * for a web server, and it is the cheapest correct move: the failure is
 * process-local state that no request can repair, a restart demonstrably clears
 * it, and a platform replaces the container in about a minute. Hanging forever is
 * not the safer option, it is the outage.
 */

/** Enough consecutive failures that a blip cannot trigger a restart. */
export const DEFAULT_FAILURES = 3;
/** Gap between probes. */
export const DEFAULT_INTERVAL_MS = 30_000;
/** How long one probe may take before it counts as a failure. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} WatchdogOptions
 * @property {(signal: AbortSignal) => Promise<unknown>} probe
 *   Runs a trivial command on the SHARED client. Given a signal, but a client
 *   that has stopped issuing connections will not observe it, so the timeout is
 *   what actually bounds the wait. Throw, or resolve falsy through your own
 *   check, to report trouble.
 * @property {string} [subject] what is being watched, for the log line and the
 *   give-up reason: "the database pool", "redis". Name it after the client, not
 *   the server, because the client is what this can actually see.
 * @property {number} [intervalMs]
 * @property {number} [timeoutMs]
 * @property {number} [failures] consecutive failures before giving up
 * @property {(reason: string) => void} [onGiveUp] defaults to `process.exit(1)`
 * @property {{error: Function, warn: Function}} [log]
 */

/**
 * @param {WatchdogOptions} o
 * @returns {{ check: () => Promise<boolean>, stop: () => void, subject: string }}
 */
export function startWatchdog({
  probe,
  subject = 'the dependency',
  intervalMs = DEFAULT_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  failures = DEFAULT_FAILURES,
  // Non-zero: this is a crash, not a drain. A platform restarts it either way,
  // but a clean exit in the deploy log would read as the app choosing to stop.
  onGiveUp = () => process.exit(1),
  log = console,
} = {}) {
  if (typeof probe !== 'function') throw new TypeError('the watchdog needs a probe');

  let consecutive = 0;
  let stopped = false;
  let timer = null;

  /** One probe. Resolves true if the client answered inside the timeout. */
  async function check() {
    if (stopped) return false;
    const controller = new AbortController();
    let timeoutId;
    const expired = Symbol('timeout');
    try {
      const outcome = await Promise.race([
        probe(controller.signal).then(() => true),
        new Promise((resolve) => {
          timeoutId = setTimeout(() => resolve(expired), timeoutMs);
        }),
      ]);
      if (outcome === expired) {
        controller.abort();
        consecutive += 1;
        log.error?.(
          `[watchdog] ${subject} did not answer in ${timeoutMs}ms (${consecutive}/${failures})`,
        );
      } else {
        // A success clears the count: the bar is CONSECUTIVE failures, so a slow
        // minute or a single dropped connection never costs a restart. The wedge
        // this watches for does not recover on its own, so it never clears.
        if (consecutive > 0)
          log.warn?.(`[watchdog] ${subject} answered again after ${consecutive}`);
        consecutive = 0;
        return true;
      }
    } catch (err) {
      // A rejection is a healthier signal than a hang: the client is still
      // refusing work, but it is refusing rather than swallowing. Counted the same.
      consecutive += 1;
      log.error?.(
        `[watchdog] ${subject} probe failed (${consecutive}/${failures}): ${err?.message ?? err}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (consecutive >= failures && !stopped) {
      stopped = true;
      clearInterval(timer);
      const reason =
        `[watchdog] ${subject} has stopped answering (${consecutive} probes in a row). ` +
        `The server itself may be fine: this is the in-process client. ` +
        `Exiting so the platform starts a container that can serve.`;
      log.error?.(reason);
      onGiveUp(reason);
    }
    return false;
  }

  timer = setInterval(check, intervalMs);
  // A watchdog is not a reason to hold the process open on its own.
  timer.unref?.();

  return {
    check,
    subject,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Start several at once, which is the usual case: a process almost always has
 * more than one client it can be wedged on, and wedging on either is the outage.
 *
 * `stop()` stops all of them. Call it FIRST on shutdown, before you close the
 * clients, or a clean drain looks like a wedge and the watchdog exits over the
 * top of it.
 *
 * @param {WatchdogOptions[]} specs
 * @param {Partial<WatchdogOptions>} [shared] defaults applied to every spec
 */
export function startWatchdogs(specs, shared = {}) {
  if (!Array.isArray(specs)) throw new TypeError('startWatchdogs needs an array of specs');
  const watchdogs = specs.map((spec) => startWatchdog({ ...shared, ...spec }));
  return {
    watchdogs,
    stop() {
      for (const w of watchdogs) w.stop();
    },
    check() {
      return Promise.all(watchdogs.map((w) => w.check()));
    },
  };
}
