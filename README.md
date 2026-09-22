# @profullstack/watchdog

Notice when a dependency has stopped answering the client your process uses, and
restart instead of hanging.

Zero dependencies. No build step. One module.

```sh
npm install @profullstack/watchdog
```

## The failure it exists for

A web process can be wedged and look perfectly healthy. It has happened to us
three times on two sites:

- **2026-09-07, Postgres.** Every page hung forever. The container was up, the
  database was healthy, the platform reported the service Online. The process had
  run about 29 hours and its connection pool had lost every slot. A query queued
  for a connection that was never going to arrive, and the pool had no queue
  deadline, so the request never failed and never answered.
- **2026-09-13 and 2026-09-22, Redis.** Same shape. The shared ioredis client is
  built with `maxRetriesPerRequest: null` because BullMQ requires it, and that
  turns a disconnect into a hang rather than a rejection. Code written as "a Redis
  blip must not take the site down" catches nothing, because there is no error to
  catch:

  ```js
  try {
    const hit = await redis.get(key); // never returns
  } catch {
    // never runs
  }
  ```

Every time, `/healthz` answered in milliseconds, because a health endpoint that
touches no dependency is measuring the wrong thing. Restarting the datastore did
not help either: the wedge is on the client side of the socket, so only replacing
the process recovered it. Every time, a person had to notice first.

## Two rules

**The probe goes through the same client the requests use.** During the Postgres
outage a freshly opened pool inside that same container ran a real query in 51ms.
A watchdog on its own connection would have reported everything fine throughout.

**The timeout is a race, not a driver option.** The symptom is a promise that
never settles, so awaiting the command alone hangs the watchdog in exactly the
case it exists for.

## Use

Most services want the same two, so there is one call for it:

```js
import { watchDependencies } from '@profullstack/watchdog';

const watchdogs = watchDependencies({
  postgres: () => healthcheck(),   // resolve truthy, or it counts as a failure
  redis: () => connection.ping(),  // must answer PONG
});

process.on('SIGTERM', async () => {
  watchdogs.stop(); // FIRST, or a clean drain looks like a wedge
  await drain();
});
```

That reads `DB_WATCHDOG_INTERVAL_MS`, `DB_WATCHDOG_TIMEOUT_MS`,
`DB_WATCHDOG_FAILURES` and the `REDIS_WATCHDOG_*` equivalents, all with working
defaults, so a service needs no new variables. Redis is allowed one more failure
than the pool, because a healthy Redis is routinely unreachable for a minute or
two while it reloads its snapshot from disk, and a watchdog that trips during a
normal restart is worse than no watchdog at all.

Pass the probes rather than the clients: this package stays zero-dependency and
never needs to know whether you are on `bun:sql`, `pg` or `ioredis`.

### Anything else

```js
import { startWatchdogs } from '@profullstack/watchdog';

const watchdogs = startWatchdogs([
  {
    subject: 'the database pool',
    probe: async () => {
      if (!(await healthcheck())) throw new Error('select 1 did not come back');
    },
  },
  {
    subject: 'redis',
    // Redis often restarts by reading a snapshot before it accepts anything, so
    // it earns a longer rope than the pool does.
    failures: 4,
    probe: async () => {
      if ((await connection.ping()) !== 'PONG') throw new Error('PING did not come back');
    },
  },
]);

process.on('SIGTERM', async () => {
  // First, before you close the clients: a clean drain must not look like a wedge.
  watchdogs.stop();
  await drain();
});
```

`startWatchdog(options)` is the single one. `startWatchdogs(specs, shared)`
applies `shared` under each spec, so common timings live in one place and a spec
overrides what it needs.

## Options

| option | default | what it is |
| --- | --- | --- |
| `probe` | required | runs a trivial command on the shared client; throw to report trouble |
| `subject` | `'the dependency'` | names the client in the log and the give-up reason |
| `intervalMs` | `30000` | gap between probes |
| `timeoutMs` | `10000` | how long one probe may take before it counts as a failure |
| `failures` | `3` | **consecutive** failures before giving up |
| `onGiveUp` | `process.exit(1)` | what to do when the client is declared gone |
| `log` | `console` | needs `error` and `warn`; either may be missing |

The bar is consecutive failures, so a slow minute never costs a restart. The
wedge this watches for does not recover on its own, so its count never clears.

`check()` runs one probe now and resolves `true` if the client answered. That is
what the tests drive, and it is useful behind an admin route.

## Why exiting is right

It reads as drastic for a web server. It is the cheapest correct move: the
failure is process-local state that no request can repair, a restart demonstrably
clears it, and a platform replaces the container in about a minute.

Hanging forever is not the safer option. It is the outage.

Note that a platform health check usually gates a new deploy and is never re-run,
so nothing else is going to restart a wedged-but-alive container.

## Licence

MIT
