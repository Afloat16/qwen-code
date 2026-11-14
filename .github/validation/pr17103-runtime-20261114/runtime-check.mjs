import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(process.argv[2]);
const outputFile = resolve(process.argv[3] ?? join(evidenceDir, 'report.json'));
const head = '58069518e9971bae2c989e1c99bd3e24f18b2221';
const base = '84b5b53f1738ef154bca3b3bd8bb40f4f3378510';
const daemonPath = 'packages/sdk-typescript/src/daemon';
const productionFile = join(sourceRoot, daemonPath, 'negotiateTransport.ts');
const baselineFile = join(evidenceDir, 'baseline-negotiateTransport.ts');
const git = (...args) =>
  execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8' }).trim();
const blobSha = (file) => {
  const bytes = readFileSync(file);
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
};
assert.equal(git('rev-parse', 'HEAD'), head);
assert.equal(git('diff', '--name-only', 'HEAD'), '');
assert.equal(
  blobSha(productionFile),
  'f6d86af0439107f65e346a5a0940db0e05eb62e0',
);
assert.equal(blobSha(baselineFile), 'bf15a89cade1c7855be6a45fdd651265c17bf711');

const baselineDir = join(evidenceDir, 'baseline-runtime');
mkdirSync(baselineDir, { recursive: true });
cpSync(join(sourceRoot, daemonPath), baselineDir, { recursive: true });
cpSync(baselineFile, join(baselineDir, 'negotiateTransport.ts'));
writeFileSync(join(baselineDir, 'package.json'), '{"type":"module"}\n');
const candidate = await import(pathToFileURL(productionFile).href);
const baseline = await import(
  pathToFileURL(join(baselineDir, 'negotiateTransport.ts')).href
);
const nativeFetch = globalThis.fetch.bind(globalThis);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const completeBody = JSON.stringify({ transports: ['acp-http', 'rest'] });

async function until(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true, value })),
      new Promise((done) => {
        timer = setTimeout(() => done({ settled: false }), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function observe(
  label,
  negotiateTransport,
  mode,
  timeoutMs,
  expected,
  baselineControl = false,
) {
  const started = performance.now();
  const elapsed = () => Math.round((performance.now() - started) * 10) / 10;
  const events = [];
  let response;
  let bodyTimer;
  let transport;
  let signal;
  let serverCleanup = false;
  const server = createServer((request, res) => {
    assert.equal(request.url, '/capabilities');
    response = res;
    events.push({ event: 'server_request', ms: elapsed() });
    res.on('close', () =>
      events.push({
        event: 'server_response_close',
        ms: elapsed(),
        finished: res.writableFinished,
        serverCleanup,
      }),
    );
    if (mode === 'headers-stall') return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    if (mode === 'complete') res.end(completeBody);
    else if (mode === 'malformed') res.end('{"transports":');
    else {
      res.write('{"transports":["acp-http"');
      if (mode === 'delayed')
        bodyTimer = setTimeout(() => res.end(',"rest"]}'), 75);
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const fetchFn = async (url, init) => {
    signal = init.signal;
    events.push({ event: 'native_fetch_start', ms: elapsed() });
    signal.addEventListener(
      'abort',
      () => events.push({ event: 'client_abort', ms: elapsed() }),
      { once: true },
    );
    const result = await nativeFetch(url, init);
    events.push({
      event: 'client_headers_received',
      ms: elapsed(),
      status: result.status,
    });
    return result;
  };
  const options =
    timeoutMs === undefined
      ? { fetchFn }
      : { fetchFn, probeTimeoutMs: timeoutMs };
  const pending = negotiateTransport(baseUrl, undefined, options).then(
    (value) => {
      transport = value;
      events.push({
        event: 'negotiation_settled',
        ms: elapsed(),
        transport: value.type,
      });
      return value;
    },
  );
  try {
    if (baselineControl) {
      const observed = await until(pending, 450);
      assert.equal(
        observed.settled,
        false,
        'unfixed implementation must remain pending past the configured deadline',
      );
      assert.equal(signal.aborted, false);
      assert.equal(response.writableFinished, false);
      events.push({
        event: 'still_pending_at_observation_window',
        ms: elapsed(),
        configuredTimeoutMs: timeoutMs,
      });
      serverCleanup = true;
      events.push({ event: 'harness_forced_disconnect', ms: elapsed() });
      response.destroy();
      const released = await until(pending, 500);
      assert.equal(released.settled, true);
      assert.equal(released.value.type, 'rest');
    } else {
      if (timeoutMs === undefined) {
        const early = await until(pending, 4800);
        assert.equal(early.settled, false);
        events.push({ event: 'default_deadline_still_pending', ms: elapsed() });
      }
      const settled = await until(
        pending,
        timeoutMs === undefined ? 1000 : 450,
      );
      assert.equal(
        settled.settled,
        true,
        'candidate must settle without server teardown',
      );
      assert.equal(settled.value.type, expected);
      if (mode === 'body-stall' || mode === 'headers-stall') {
        assert.equal(signal.aborted, true);
        assert.equal(serverCleanup, false);
        if (mode === 'body-stall')
          assert.ok(
            events.some((event) => event.event === 'client_headers_received'),
          );
      } else {
        await wait(timeoutMs + 50);
        assert.equal(
          signal.aborted,
          false,
          'settled probe must release its deadline',
        );
      }
    }
    return {
      label,
      mode,
      configuredTimeoutMs: timeoutMs ?? 'default 5000',
      expected,
      passed: true,
      signalAborted: signal.aborted,
      events,
    };
  } finally {
    serverCleanup = true;
    events.push({ event: 'harness_cleanup', ms: elapsed() });
    clearTimeout(bodyTimer);
    transport?.dispose();
    const closed = new Promise((done) => server.close(done));
    server.closeAllConnections();
    await closed;
  }
}

const observations = [];
observations.push(
  await observe(
    'candidate complete ACP HTTP body',
    candidate.negotiateTransport,
    'complete',
    100,
    'acp-http',
  ),
);
observations.push(
  await observe(
    'candidate body stalls after 200 headers',
    candidate.negotiateTransport,
    'body-stall',
    100,
    'rest',
  ),
);
observations.push(
  await observe(
    'candidate complete delayed body',
    candidate.negotiateTransport,
    'delayed',
    250,
    'acp-http',
  ),
);
observations.push(
  await observe(
    'candidate malformed finite JSON',
    candidate.negotiateTransport,
    'malformed',
    100,
    'rest',
  ),
);
observations.push(
  await observe(
    'candidate headers never arrive',
    candidate.negotiateTransport,
    'headers-stall',
    100,
    'rest',
  ),
);
observations.push(
  await observe(
    'candidate default deadline with stalled body',
    candidate.negotiateTransport,
    'body-stall',
    undefined,
    'rest',
  ),
);
observations.push(
  await observe(
    'base body stall control',
    baseline.negotiateTransport,
    'body-stall',
    100,
    'pending at 450ms until forced teardown',
    true,
  ),
);
assert.equal(git('rev-parse', 'HEAD'), head);
assert.equal(git('diff', '--name-only', 'HEAD'), '');
assert.equal(
  blobSha(productionFile),
  'f6d86af0439107f65e346a5a0940db0e05eb62e0',
);
const report = {
  pr: 'https://github.com/QwenLM/qwen-code/pull/17103',
  verifiedHead: head,
  controlBase: base,
  recordedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    loader: 'tsx 4.23.9',
  },
  implementation:
    'Exact source module imported through tsx; actual REST and ACP-HTTP classes; real loopback HTTP and native Node fetch. The observing fetch wrapper only records headers and AbortSignal events and forwards original arguments and Response unchanged.',
  identity: {
    candidateBlob: blobSha(productionFile),
    controlBlob: blobSha(baselineFile),
    trackedSourceChanged: false,
  },
  scope:
    'Runtime evidence for capabilities negotiation, not a daemon/model end-to-end run or a full workspace build. Real clock observations are not assertions of millisecond-perfect scheduling. The baseline changes only negotiateTransport.ts; other loaded runtime sources come from the candidate and are unchanged by this PR.',
  observations,
};
writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    verifiedHead: head,
    observations: observations.length,
    passed: observations.filter((row) => row.passed).length,
    report: outputFile,
  }),
);
