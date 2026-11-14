import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAcpSessionBridge, createSpawnChannelFactory } from './bridge-runtime.mjs';

const root = path.dirname(new URL(import.meta.url).pathname);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const results = [];
const transcriptPage = (text, hasMore = false) => ({ v: 1, events: [{ v: 1, type: 'session_update', data: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } }], hasMore });
async function until(predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(10); }
  throw new Error(`Timed out observing ${label}`);
}
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function scenario(name, operation) {
  const directory = path.join(root, 'runs', runId, name);
  fs.mkdirSync(directory, { recursive: true });
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(directory, 'persisted-page.json'), JSON.stringify(transcriptPage(`PERSISTED:${name}`)) + '\n');
  const events = [];
  const abort = new AbortController();
  const bridge = createAcpSessionBridge({
    boundWorkspace: workspace,
    channelFactory: createSpawnChannelFactory({
      sourceEnv: { PATH: process.env.PATH, QWEN_CLI_ENTRY: path.join(root, 'acp-peer.mjs'), QWEN_RUNTIME_DIR: path.join(directory, 'runtime'), ACP_OBSERVATION_DIR: directory },
      onDiagnosticLine: (line) => fs.appendFileSync(path.join(directory, 'diagnostics.log'), line + '\n'),
    }),
  });
  let eventReader;
  let ready;
  try {
    const session = await bounded(bridge.spawnOrAttach({ workspaceCwd: workspace }), 'spawnOrAttach');
    ready = await until(() => fs.existsSync(path.join(directory, 'peer-ready.json')) && JSON.parse(fs.readFileSync(path.join(directory, 'peer-ready.json'), 'utf8')), 'child control listener');
    assert.notEqual(ready.pid, process.pid);
    assert.equal(ready.parentPid, process.pid);
    const control = async (command) => {
      const response = await fetch(`http://127.0.0.1:${ready.port}`, { method: 'POST', body: JSON.stringify(command), signal: AbortSignal.timeout(5000) });
      const body = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(body));
      return body;
    };
    eventReader = (async () => { for await (const event of bridge.subscribeEvents(session.sessionId, { signal: abort.signal })) events.push(event); })();
    const request = { sessionId: session.sessionId, workspaceCwd: workspace, clientId: session.clientId, historyReplay: 'response', liveReplayMode: 'summary', historyPageSize: 100 };
    const context = {
      bridge, session, control, request, events,
      status: () => control({ action: 'status' }),
      load: () => bounded(bridge.loadSession(request), 'paged load'),
      active: () => bridge.getSessionSummary(session.sessionId).hasActivePrompt,
      live: (text) => JSON.stringify(bridge.getSessionReplaySnapshot(session.sessionId)).includes(text),
      readCount: async () => (await control({ action: 'status' })).transcripts.length,
    };
    const observation = await operation(context);
    const final = await context.status();
    const result = { scenario: name, status: 'PASS', head: '7c16962f5ed04d61eff25accadc105e18be6cb34', evidenceDirectory: path.relative(root, directory), parentPid: process.pid, childPid: ready.pid, ...observation, finalProtocolCounts: { prompts: final.prompts.length, transcriptRequests: final.transcripts.length } };
    results.push(result);
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {
    abort.abort();
    await eventReader?.catch(() => {});
    fs.writeFileSync(path.join(directory, 'bridge-events.ndjson'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    await bridge.shutdown();
    if (ready) {
      let exited = false;
      try { process.kill(ready.pid, 0); } catch { exited = true; }
      assert.equal(exited, true, `ACP peer ${ready.pid} must exit during bridge shutdown`);
    }
  }
}
async function begin(context, kind, text) {
  const { bridge, session, control } = context;
  let prompt;
  if (kind === 'foreground') {
    prompt = bridge.sendPrompt(session.sessionId, { sessionId: session.sessionId, prompt: [{ type: 'text', text }] }, undefined, { clientId: session.clientId });
    prompt.catch(() => {});
    await until(async () => (await context.status()).prompts.length === 1, 'child prompt arrival');
  } else {
    const result = await control({ action: kind === 'goal' ? 'start-goal' : 'start-background', sessionId: session.sessionId, text });
    if (kind === 'background') assert.equal(result.accepted, true);
  }
  await until(context.active, `${kind} active state`);
  if (text) await until(() => context.live(text), `${kind} visible live response`);
  return { prompt };
}
async function end(context, kind, pending) {
  if (kind === 'foreground') {
    await context.control({ action: 'release-prompt', sessionId: context.session.sessionId });
    await bounded(pending.prompt, 'prompt completion');
  } else {
    await context.control({ action: 'end-turn', sessionId: context.session.sessionId, source: kind === 'goal' ? 'goal' : 'background_notification', reason: 'end_turn', turnId: kind === 'background' ? 'runtime-background' : undefined });
  }
  await until(() => !context.active(), 'idle state');
}
try {
  for (const kind of ['foreground', 'background', 'goal']) {
    await scenario(`active-${kind}`, async (context) => {
      const prompt = await begin(context, kind, `LIVE:${kind}`);
      const before = await context.readCount();
      const loaded = await bounded(Promise.all([context.load(), context.load()]), 'two concurrent active loads');
      const after = await context.readCount();
      assert.equal(before, 0); assert.equal(after, 0); assert.equal(context.active(), true);
      for (const replay of loaded) assert.ok(JSON.stringify(replay.liveJournal).includes(`LIVE:${kind}`));
      await end(context, kind, prompt);
      const idle = await context.load();
      assert.equal(await context.readCount(), 1);
      assert.ok(JSON.stringify(idle.compactedReplay).includes(`PERSISTED:active-${kind}`));
      return { activeLoadsReturned: loaded.length, activeTranscriptRequests: after - before, activeDuringReturn: true, idleTranscriptRequests: 1, idlePersistedContentReturned: true };
    });
  }
  await scenario('inflight-goal-no-journal', async (context) => {
    await context.control({ action: 'page', hold: true, page: transcriptPage('STALE:PERSISTED') });
    const loading = context.load();
    await until(async () => (await context.status()).heldPages === 1, 'first persisted page held');
    const before = context.bridge.getSessionLastEventId(context.session.sessionId);
    await begin(context, 'goal');
    assert.equal(context.bridge.getSessionLastEventId(context.session.sessionId), before);
    await context.control({ action: 'release-pages' });
    const result = await loading;
    assert.equal(await context.readCount(), 1);
    assert.ok(!JSON.stringify(result).includes('STALE:PERSISTED'));
    await end(context, 'goal');
    return { heldIdlePageRequests: 1, goalStartedWithoutJournalEvent: true, furtherTranscriptRequests: 0, stalePersistedContentReturned: false };
  });
  await scenario('inflight-foreground-empty-page', async (context) => {
    await context.control({ action: 'page', hold: true, page: { v: 1, events: [], hasMore: true, nextCursor: 'older-fixture-page' } });
    const loading = context.load();
    await until(async () => (await context.status()).heldPages === 1, 'empty persisted page held');
    const prompt = await begin(context, 'foreground', 'LIVE:after-empty-page');
    await context.control({ action: 'release-pages' });
    const result = await loading;
    assert.equal(await context.readCount(), 1);
    assert.ok(JSON.stringify(result.liveJournal).includes('LIVE:after-empty-page'));
    await end(context, 'foreground', prompt);
    return { heldIdlePageRequests: 1, emptyPageHadCursor: true, cursorFollowupRequests: 0, liveResponseReturned: true };
  });
  for (const [label, reason] of [['valid', 'end_turn'], ['empty', ''], ['overlong', 'x'.repeat(129)]]) {
    await scenario(`goal-terminal-${label}`, async (context) => {
      const { bridge, session, control } = context;
      await begin(context, 'goal', `LIVE:goal-${label}`);
      const active = await context.load();
      assert.ok(JSON.stringify(active.liveJournal).includes(`LIVE:goal-${label}`));
      assert.equal(await context.readCount(), 0);
      const messageId = `runtime-queued-${label}`;
      const admission = bridge.enqueueMidTurnMessage(session.sessionId, `queued message ${label}`, { clientId: session.clientId }, messageId, { rejectIfIdle: true });
      assert.equal(admission.accepted, true);
      assert.equal((await context.status()).prompts.length, 0);
      const goalPromptId = `${session.sessionId}########runtime-goal`;
      await control({ action: 'end-turn', sessionId: session.sessionId, source: 'goal', reason, promptId: goalPromptId });
      await until(async () => (await context.status()).prompts.length === 1, 'queued prompt dispatched');
      assert.deepEqual(bridge.getPendingPrompts(session.sessionId).map((item) => item.promptId), [messageId]);
      assert.equal(bridge.getMidTurnMessages(session.sessionId, { clientId: session.clientId }).messages.length, 0);
      if (label === 'valid') await until(() => context.events.some((event) => event.type === 'turn_complete' && event.promptId === goalPromptId), 'valid Goal completion event');
      const completionCount = context.events.filter((event) => event.type === 'turn_complete' && event.promptId === goalPromptId).length;
      assert.equal(completionCount, label === 'valid' ? 1 : 0);
      await control({ action: 'release-prompt', sessionId: session.sessionId });
      await until(() => bridge.getPendingPrompts(session.sessionId).length === 0 && !context.active(), 'queued turn completion');
      const idle = await context.load();
      assert.equal(await context.readCount(), 1);
      assert.ok(JSON.stringify(idle.compactedReplay).includes(`PERSISTED:goal-terminal-${label}`));
      assert.equal((await context.status()).prompts.length, 1);
      return { reasonLength: reason.length, activeTranscriptRequests: 0, queuedMessageAccepted: true, promptCallsBeforeTerminal: 0, promotedPromptCalls: 1, remainingMidTurnMessages: 0, goalCompletionEvents: completionCount, idleTranscriptRequests: 1, idlePersistedContentReturned: true };
    });
  }
  fs.writeFileSync(path.join(root, 'runtime-results.json'), JSON.stringify({ head: '7c16962f5ed04d61eff25accadc105e18be6cb34', node: process.version, platform: process.platform, arch: process.arch, completedAt: new Date().toISOString(), status: 'PASS', scenarios: results }, null, 2) + '\n');
} catch (error) {
  fs.writeFileSync(path.join(root, 'runtime-failure.json'), JSON.stringify({ error: String(error), stack: error.stack, completed: results }, null, 2) + '\n');
  throw error;
}
