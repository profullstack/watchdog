import { describe, expect, it } from 'bun:test';
import { startWatchdog, startWatchdogs } from '../src/watchdog.js';

/** Swallow the watchdog's own logging so a passing run stays readable. */
const quiet = { error() {}, warn() {} };

/** The symptom exactly: a command that never settles, in either direction. */
const neverSettles = () => new Promise(() => {});

describe('a watchdog', () => {
  it('gives up after the client stops answering, and says so once', async () => {
    const reasons = [];
    const w = startWatchdog({
      probe: neverSettles,
      subject: 'the database pool',
      // Long enough that only an explicit check() drives this test.
      intervalMs: 60_000,
      timeoutMs: 5,
      failures: 3,
      onGiveUp: (reason) => reasons.push(reason),
      log: quiet,
    });

    expect(await w.check()).toBe(false);
    expect(await w.check()).toBe(false);
    expect(reasons).toEqual([]);

    // The third consecutive failure is the one that restarts the container.
    expect(await w.check()).toBe(false);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('the database pool');
    expect(reasons[0]).toContain('stopped answering');

    // And it does not keep firing after it has given up, which would turn one
    // restart into a loop of them.
    await w.check();
    expect(reasons).toHaveLength(1);
    w.stop();
  });

  it('never gives up while the client is answering', async () => {
    const reasons = [];
    const w = startWatchdog({
      probe: async () => true,
      intervalMs: 60_000,
      timeoutMs: 50,
      failures: 2,
      onGiveUp: (reason) => reasons.push(reason),
      log: quiet,
    });

    for (let i = 0; i < 5; i += 1) expect(await w.check()).toBe(true);
    expect(reasons).toEqual([]);
    w.stop();
  });

  it('counts a rejection the same as a hang', async () => {
    const reasons = [];
    const w = startWatchdog({
      probe: async () => {
        throw new Error('ERR_POSTGRES_CONNECTION_CLOSED');
      },
      intervalMs: 60_000,
      timeoutMs: 50,
      failures: 2,
      onGiveUp: (reason) => reasons.push(reason),
      log: quiet,
    });

    await w.check();
    await w.check();
    expect(reasons).toHaveLength(1);
    w.stop();
  });

  it('forgives a blip: one success clears the count', async () => {
    // The bar is CONSECUTIVE failures. A client that answers again has
    // recovered, and restarting it would be the watchdog causing the outage.
    const reasons = [];
    let healthy = false;
    const w = startWatchdog({
      probe: async () => {
        healthy = !healthy;
        if (!healthy) throw new Error('down');
        return true;
      },
      intervalMs: 60_000,
      timeoutMs: 50,
      failures: 2,
      onGiveUp: (reason) => reasons.push(reason),
      log: quiet,
    });

    await w.check(); // healthy -> true, resets
    expect(reasons).toEqual([]);
    await w.check(); // fails, 1
    await w.check(); // healthy again, resets to 0
    expect(reasons).toEqual([]);
    w.stop();
  });

  it('stays quiet after stop(), so a clean drain is not read as a wedge', async () => {
    const reasons = [];
    const w = startWatchdog({
      probe: neverSettles,
      intervalMs: 60_000,
      timeoutMs: 5,
      failures: 1,
      onGiveUp: (reason) => reasons.push(reason),
      log: quiet,
    });
    w.stop();
    expect(await w.check()).toBe(false);
    expect(reasons).toEqual([]);
  });

  it('names the subject so a deploy log says which client went', async () => {
    const reasons = [];
    const w = startWatchdog({
      subject: 'redis',
      probe: async () => {
        throw new Error('Connection is closed.');
      },
      intervalMs: 60_000,
      timeoutMs: 50,
      failures: 1,
      onGiveUp: (reason) => reasons.push(reason),
      log: quiet,
    });
    await w.check();
    expect(reasons[0]).toContain('redis');
    w.stop();
  });

  it('refuses to start without a probe', () => {
    expect(() => startWatchdog({})).toThrow(/probe/);
  });

  it('does not hold the process open on its own', () => {
    // An interval that keeps the event loop alive would stop a CLI or a test run
    // from exiting; the watchdog is a passenger on a server that is already up.
    const w = startWatchdog({ probe: async () => true, log: quiet });
    expect(typeof w.stop).toBe('function');
    w.stop();
  });

  it('tolerates a log object that implements neither method', async () => {
    // Hosts pass their own logger. A missing warn() must not turn a recovery
    // into a crash inside the thing watching for crashes.
    const w = startWatchdog({
      probe: async () => {
        throw new Error('down');
      },
      intervalMs: 60_000,
      timeoutMs: 5,
      failures: 99,
      log: {},
    });
    expect(await w.check()).toBe(false);
    w.stop();
  });
});

describe('a group of watchdogs', () => {
  it('watches every client, and one wedge is enough', async () => {
    // A process is almost always wedgeable on more than one client, and either
    // one is the outage.
    const reasons = [];
    const g = startWatchdogs(
      [
        { subject: 'the database pool', probe: async () => true },
        { subject: 'redis', probe: neverSettles },
      ],
      {
        intervalMs: 60_000,
        timeoutMs: 5,
        failures: 1,
        onGiveUp: (reason) => reasons.push(reason),
        log: quiet,
      },
    );

    expect(await g.check()).toEqual([true, false]);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('redis');
    g.stop();
  });

  it('lets a spec override the shared defaults', async () => {
    // Redis is routinely unreachable for a while on a restart, so it earns a
    // longer rope than the pool does.
    const g = startWatchdogs(
      [
        { subject: 'pool', probe: async () => true },
        { subject: 'redis', probe: async () => true, failures: 9 },
      ],
      { failures: 3, intervalMs: 60_000, log: quiet },
    );
    expect(g.watchdogs).toHaveLength(2);
    expect(g.watchdogs[1].subject).toBe('redis');
    g.stop();
  });

  it('stop() silences all of them', async () => {
    const reasons = [];
    const g = startWatchdogs([{ subject: 'a', probe: neverSettles }], {
      intervalMs: 60_000,
      timeoutMs: 5,
      failures: 1,
      onGiveUp: (reason) => reasons.push(reason),
      log: quiet,
    });
    g.stop();
    await g.check();
    expect(reasons).toEqual([]);
  });

  it('refuses anything that is not an array of specs', () => {
    expect(() => startWatchdogs({})).toThrow(/array/);
  });
});
