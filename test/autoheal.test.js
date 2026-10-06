import { describe, expect, it } from 'bun:test';
import { healOnce, parseHealth } from '../src/autoheal.js';

const quiet = { error() {}, warn() {} };
const c = (name, health, optedOut = false) => ({ id: `id-${name}`, name, health, optedOut });

/** A fake Docker: a fixed list, and a record of what was restarted. */
function fakeDocker(containers, { failOn = [] } = {}) {
  const restarted = [];
  return {
    restarted,
    list: async () => containers,
    restart: async (x) => {
      if (failOn.includes(x.name)) throw new Error('no such container');
      restarted.push(x.name);
    },
  };
}

describe('parseHealth', () => {
  it('reads the health Docker puts in the status column', () => {
    expect(parseHealth('Up 2 hours (unhealthy)')).toBe('unhealthy');
    expect(parseHealth('Up 3 days (healthy)')).toBe('healthy');
    expect(parseHealth('Up 5 seconds (health: starting)')).toBe('starting');
    expect(parseHealth('Up 4 days')).toBe('none');
  });
});

describe('healOnce', () => {
  it('restarts only unhealthy containers, and leaves opted-out ones alone', async () => {
    const d = fakeDocker([
      c('web', 'unhealthy'),
      c('ok', 'healthy'),
      c('booting', 'starting'),
      c('blind', 'none'),
      c('pet', 'unhealthy', true),
    ]);
    const r = await healOnce({ ...d, log: quiet, now: 1000 });
    expect(d.restarted).toEqual(['web']);
    expect(r.restarted).toEqual(['web']);
    expect(r.state.restarts).toEqual({ web: [1000] });
  });

  it('stops after the budget and reports the container once, not every pass', async () => {
    const d = fakeDocker([c('broken', 'unhealthy')]);
    let state;
    const gaveUp = [];
    for (let i = 0; i < 6; i++) {
      const r = await healOnce({ ...d, state, now: 1000 + i, maxRestarts: 3, log: quiet });
      state = r.state;
      gaveUp.push(...r.gaveUp);
    }
    // A container that comes back unhealthy every time is not helped by a
    // fourth restart; it is helped by a person reading its logs.
    expect(d.restarted).toHaveLength(3);
    expect(gaveUp).toEqual(['broken']);
  });

  it('gets a fresh budget once old restarts age out of the window', async () => {
    const d = fakeDocker([c('flaky', 'unhealthy')]);
    const state = { restarts: { flaky: [0, 1, 2] }, gaveUp: { flaky: 2 } };
    const r = await healOnce({ ...d, state, now: 10_000, windowMs: 5_000, log: quiet });
    expect(d.restarted).toEqual(['flaky']);
    expect(r.state.restarts.flaky).toEqual([10_000]);
  });

  it('clears the give-up mark when the container recovers, so a relapse is reported again', async () => {
    const d = fakeDocker([c('svc', 'healthy')]);
    const state = { restarts: { svc: [1, 2, 3] }, gaveUp: { svc: 3 } };
    const r = await healOnce({ ...d, state, now: 10, log: quiet });
    expect(r.state.gaveUp).toEqual({});
  });

  it('forgets containers that no longer exist', async () => {
    const d = fakeDocker([c('kept', 'healthy')]);
    const state = { restarts: { gone: [5], kept: [5] }, gaveUp: { gone: 5 } };
    const r = await healOnce({ ...d, state, now: 10, log: quiet });
    expect(r.state).toEqual({ restarts: { kept: [5] }, gaveUp: {} });
  });

  it('does not spend budget on a restart that failed, and keeps going', async () => {
    const d = fakeDocker([c('a', 'unhealthy'), c('b', 'unhealthy')], { failOn: ['a'] });
    const r = await healOnce({ ...d, now: 1, log: quiet });
    expect(r.failed).toEqual(['a']);
    expect(d.restarted).toEqual(['b']);
    expect(r.state.restarts.a).toBeUndefined();
  });

  it('restarts nothing on a dry run', async () => {
    const d = fakeDocker([c('web', 'unhealthy')]);
    const r = await healOnce({ ...d, dryRun: true, now: 1, log: quiet });
    expect(d.restarted).toEqual([]);
    expect(r.restarted).toEqual(['web']);
    expect(r.state.restarts).toEqual({});
  });
});
