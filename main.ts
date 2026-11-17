// Quickforge entry point: the lifecycle between this process and the trial
// harness that runs beside it.
//
// The harness owns an HTTP origin named by MAKEFUN_ENV_URL. This process
// binds an ephemeral TCP port (never 8080, which belongs to the harness),
// announces the port with POST /register, then polls GET /done until the
// harness answers {"done": true}, at which point it closes the server and
// exits 0. The first registration wins, so a 409 is a normal answer, not an
// error worth dying over; a 400 or 405 means the request itself broke the
// contract and the process stops.
//
// When MAKEFUN_ENV_URL is absent the process is being run by hand: it binds
// PORT (or an ephemeral port) and serves until killed, which is how the forge
// is exercised locally with a real git client.

import { createApp } from './app.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff between harness polls: 250 ms doubling to a 2 s cap. */
function pollDelay(attempt: number): number {
  return Math.min(2_000, 250 * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the harness takes it (200) or says it already has one (409). */
async function announce(envUrl: string, port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
      // The harness may still be starting; fall through and retry.
    }
    await sleep(pollDelay(attempt));
  }
}

/** Poll GET /done until the harness ends the trial. */
async function awaitDone(envUrl: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet is not "done"; keep polling.
    }
    await sleep(pollDelay(attempt));
  }
}

async function run(): Promise<void> {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  const server = createApp();
  const wanted = envUrl === '' && process.env.PORT !== undefined ? Number(process.env.PORT) : 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(wanted, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server bound no TCP port');
  process.stdout.write(`[quickforge] listening on port ${address.port}\n`);

  if (envUrl === '') {
    process.stdout.write('[quickforge] MAKEFUN_ENV_URL unset: serving standalone\n');
    return;
  }
  await announce(envUrl, address.port);
  process.stdout.write('[quickforge] registered; waiting for done\n');
  await awaitDone(envUrl);
  server.close();
  process.stdout.write('[quickforge] done\n');
  process.exit(0);
}

try {
  await run();
} catch (err) {
  process.stderr.write(`[quickforge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
