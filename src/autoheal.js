/**
 * Restart containers Docker has already decided are unhealthy.
 *
 * Docker runs a HEALTHCHECK, counts the failures, marks the container
 * `unhealthy`, and then does nothing. A restart policy only fires when the
 * process EXITS, so a container whose event loop is blocked, or whose server has
 * stopped accepting while the process lives on, sits there marked unhealthy until
 * a person notices. On dev2 on 2026-10-06 that was 183 health-checked containers
 * with nothing acting on the result.
 *
 * The in-process watchdog in `./watchdog.js` cannot cover this case. A blocked
 * event loop never runs the watchdog's timer either, so the only thing that can
 * see it is something outside the process, and Docker's healthcheck already is
 * that thing. This module closes the loop: it reads the verdict Docker has
 * reached and acts on it.
 *
 * Two things keep it from making an outage worse.
 *
 * **It trusts Docker's streak, it does not add its own.** `unhealthy` already
 * means `retries` consecutive failures (three by default) after `start_period`.
 * Requiring more here would only add minutes to every real wedge.
 *
 * **Restarts are budgeted per container.** A container that is unhealthy because
 * its database is down, or because the image is broken, will be unhealthy again
 * the moment it comes back. Restarting it forever hides the problem and churns
 * the box. After `maxRestarts` inside `windowMs` it stops restarting that
 * container and reports it once as needing a person.
 *
 * Opt out per container with the label `autoheal=false`.
 */

import { execFile } from 'node:child_process';

/** Restarts allowed per container inside one window before handing to a person. */
export const DEFAULT_MAX_RESTARTS = 3;
/** The budget window. */
export const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

/**
 * @typedef {object} Container
 * @property {string} id
 * @property {string} name
 * @property {'healthy'|'unhealthy'|'starting'|'none'} health
 * @property {boolean} optedOut label autoheal=false
 */

/**
 * @typedef {object} HealState
 * @property {Record<string, number[]>} restarts restart timestamps per container name
 * @property {Record<string, number>} gaveUp when each exhausted container was reported
 */

/**
 * One pass. Pure apart from the injected `list` and `restart`, so it is the
 * whole policy and the tests drive it without Docker.
 *
 * @param {object} o
 * @param {() => Promise<Container[]>} o.list
 * @param {(c: Container) => Promise<void>} o.restart
 * @param {HealState} [o.state] carried between passes; returned updated
 * @param {number} [o.now]
 * @param {number} [o.maxRestarts]
 * @param {number} [o.windowMs]
 * @param {boolean} [o.dryRun]
 * @param {{error: Function, warn: Function, info?: Function}} [o.log]
 * @returns {Promise<{state: HealState, restarted: string[], gaveUp: string[], failed: string[], containers: Container[]}>}
 */
export async function healOnce({
  list,
  restart,
  state = { restarts: {}, gaveUp: {} },
  now = Date.now(),
  maxRestarts = DEFAULT_MAX_RESTARTS,
  windowMs = DEFAULT_WINDOW_MS,
  dryRun = false,
  log = console,
}) {
  const containers = await list();
  const next = { restarts: {}, gaveUp: {} };
  const restarted = [];
  const gaveUp = [];
  const failed = [];

  // Forget restarts that have aged out of the window, and containers that no
  // longer exist, so the state file cannot grow without bound.
  const live = new Set(containers.map((c) => c.name));
  for (const [name, times] of Object.entries(state.restarts ?? {})) {
    const recent = times.filter((t) => now - t < windowMs);
    if (recent.length && live.has(name)) next.restarts[name] = recent;
  }
  for (const [name, at] of Object.entries(state.gaveUp ?? {})) {
    // Keep the "already reported" mark only while the container is still out of
    // budget; once it recovers or the window passes it may be reported again.
    if (live.has(name) && now - at < windowMs) next.gaveUp[name] = at;
  }

  for (const c of containers) {
    if (c.health !== 'unhealthy') {
      if (c.health === 'healthy') delete next.gaveUp[c.name];
      continue;
    }
    if (c.optedOut) continue;

    const recent = next.restarts[c.name] ?? [];
    if (recent.length >= maxRestarts) {
      if (!next.gaveUp[c.name]) {
        next.gaveUp[c.name] = now;
        gaveUp.push(c.name);
        log.error?.(
          `[autoheal] ${c.name} is still unhealthy after ${recent.length} restarts in ` +
            `${Math.round(windowMs / 60000)} minutes. Restarting it again will not help; ` +
            `it needs a person.`,
        );
      }
      continue;
    }

    if (dryRun) {
      log.warn?.(`[autoheal] would restart ${c.name} (unhealthy)`);
      restarted.push(c.name);
      continue;
    }
    try {
      await restart(c);
      next.restarts[c.name] = [...recent, now];
      restarted.push(c.name);
      log.warn?.(
        `[autoheal] restarted ${c.name}: Docker marked it unhealthy ` +
          `(${recent.length + 1}/${maxRestarts} this window)`,
      );
    } catch (err) {
      failed.push(c.name);
      log.error?.(`[autoheal] could not restart ${c.name}: ${err?.message ?? err}`);
    }
  }

  return { state: next, restarted, gaveUp, failed, containers };
}

/** Run a docker command and resolve its stdout. */
function docker(args, { bin = 'docker', timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim()));
        else resolve(stdout);
      },
    );
  });
}

/**
 * Turn `docker ps` Status text into a health value. Docker only exposes health
 * in that column ("Up 2 hours (unhealthy)", "Up 5 seconds (health: starting)").
 *
 * @param {string} status
 * @returns {Container['health']}
 */
export function parseHealth(status) {
  if (/\(unhealthy\)/.test(status)) return 'unhealthy';
  if (/\(health: starting\)/.test(status)) return 'starting';
  if (/\(healthy\)/.test(status)) return 'healthy';
  return 'none';
}

/** Running containers with their health, from one `docker ps`. */
export async function listDockerContainers({ bin } = {}) {
  const out = await docker(
    ['ps', '--no-trunc', '--format', '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Label "autoheal"}}'],
    { bin },
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, name, status = '', label = ''] = line.split('\t');
      return { id, name, health: parseHealth(status), optedOut: label.trim() === 'false' };
    });
}

/** `docker restart` with a stop timeout, so a wedged process is killed, not waited on. */
export function restartDockerContainer(c, { bin, stopTimeoutS = 20 } = {}) {
  return docker(['restart', '-t', String(stopTimeoutS), c.id], { bin });
}
