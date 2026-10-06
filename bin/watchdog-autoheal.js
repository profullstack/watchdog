#!/usr/bin/env node
/**
 * watchdog-autoheal: restart the containers Docker has marked unhealthy.
 *
 *   watchdog-autoheal            one pass, for cron (the default)
 *   watchdog-autoheal watch      loop every --interval seconds, for a service unit
 *   watchdog-autoheal status     what is healthy, unhealthy, and not checked at all
 *
 * Options:
 *   --dry-run              say what would be restarted, restart nothing
 *   --json                 machine-readable output (status and run)
 *   --max-restarts N       per container per window before handing to a person (3)
 *   --window MINUTES       the restart budget window (60)
 *   --interval SECONDS     gap between passes in watch mode (30)
 *   --state PATH           where the restart budget is kept between passes
 *   --notify CMD           run CMD (via sh) with the message on stdin when a
 *                          container exhausts its budget, e.g. a mail command
 *
 * Opt a container out with the label autoheal=false.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_MAX_RESTARTS,
  DEFAULT_WINDOW_MS,
  healOnce,
  listDockerContainers,
  restartDockerContainer,
} from '../src/autoheal.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const num = (name, fallback) => {
  const n = Number(opt(name, fallback));
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`--${name} must be a positive number`);
    process.exit(2);
  }
  return n;
};

if (flag('help') || flag('h')) {
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  console.log(
    src
      .split('*/')[0]
      .split('\n')
      .slice(2)
      .map((l) => l.replace(/^ \*?\s?/, ''))
      .join('\n')
      .trim(),
  );
  process.exit(0);
}

const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'run';
const json = flag('json');
const dryRun = flag('dry-run');
const maxRestarts = num('max-restarts', DEFAULT_MAX_RESTARTS);
const windowMs = num('window', DEFAULT_WINDOW_MS / 60000) * 60000;
const intervalMs = num('interval', 30) * 1000;
const notify = opt('notify');
const statePath = opt(
  'state',
  join(
    process.env.XDG_STATE_HOME || join(homedir(), '.local/state'),
    'watchdog-autoheal/state.json',
  ),
);

// Timestamped, so a cron log reads on its own.
const stamp = () => new Date().toISOString();
const log = {
  error: (m) => console.error(`${stamp()} ${m}`),
  warn: (m) => console.error(`${stamp()} ${m}`),
};

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    // Missing or torn: start with a full budget. Worst case is a few extra
    // restarts, which is what having no state would mean anyway.
    return { restarts: {}, gaveUp: {} };
  }
}

function writeState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, statePath);
}

function runNotify(message) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', notify], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', (err) => {
      log.error(`[autoheal] --notify failed: ${err.message}`);
      resolve();
    });
    child.on('close', resolve);
    child.stdin.end(message);
  });
}

async function pass() {
  const result = await healOnce({
    list: () => listDockerContainers(),
    restart: (c) => restartDockerContainer(c),
    state: readState(),
    maxRestarts,
    windowMs,
    dryRun,
    log,
  });
  if (!dryRun) writeState(result.state);
  if (notify && result.gaveUp.length) {
    await runNotify(
      `watchdog-autoheal gave up on ${result.gaveUp.join(', ')}: still unhealthy after ` +
        `${maxRestarts} restarts in ${windowMs / 60000} minutes. Restarting again will not ` +
        `help; look at the logs (docker logs --tail 200 <name>).\n`,
    );
  }
  return result;
}

async function status() {
  const containers = await listDockerContainers();
  const by = (h) =>
    containers
      .filter((c) => c.health === h)
      .map((c) => c.name)
      .sort();
  const state = readState();
  const report = {
    total: containers.length,
    healthy: by('healthy').length,
    starting: by('starting'),
    unhealthy: by('unhealthy'),
    // These are the blind spot: nothing outside the process looks at them, so a
    // wedge there is only found by a person.
    noHealthcheck: by('none'),
    optedOut: containers
      .filter((c) => c.optedOut)
      .map((c) => c.name)
      .sort(),
    restartsThisWindow: state.restarts ?? {},
    gaveUp: Object.keys(state.gaveUp ?? {}),
  };
  if (json) return console.log(JSON.stringify(report, null, 2));
  console.log(
    `${report.total} running: ${report.healthy} healthy, ${report.unhealthy.length} unhealthy, ` +
      `${report.starting.length} starting, ${report.noHealthcheck.length} with no healthcheck`,
  );
  for (const [label, names] of [
    ['unhealthy', report.unhealthy],
    ['given up on', report.gaveUp],
    ['no healthcheck (autoheal cannot see these)', report.noHealthcheck],
    ['opted out', report.optedOut],
  ]) {
    if (names.length) console.log(`\n${label}:\n  ${names.join('\n  ')}`);
  }
  const restarts = Object.entries(report.restartsThisWindow);
  if (restarts.length) {
    console.log('\nrestarted this window:');
    for (const [name, times] of restarts) console.log(`  ${name} x${times.length}`);
  }
}

try {
  if (command === 'status') {
    await status();
  } else if (command === 'run') {
    const r = await pass();
    if (json) {
      const { containers, state, ...rest } = r;
      console.log(JSON.stringify({ checked: containers.length, ...rest }));
    }
    process.exitCode = r.failed.length ? 1 : 0;
  } else if (command === 'watch') {
    for (;;) {
      try {
        await pass();
      } catch (err) {
        // One failed pass (dockerd restarting, say) must not end the loop.
        log.error(`[autoheal] pass failed: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  } else {
    console.error(`unknown command "${command}" (run, watch, status; --help)`);
    process.exit(2);
  }
} catch (err) {
  log.error(`[autoheal] ${err.message}`);
  process.exit(1);
}
