import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable, Writable, Transform } from 'node:stream';
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';

const evidence = process.env.ACP_OBSERVATION_DIR;
const pagePath = path.join(evidence, 'persisted-page.json');
const wirePath = path.join(evidence, 'wire.ndjson');
let sequence = 0;
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /capability|token|authorization/i.test(key) && typeof item === 'string' ? '[fixture capability redacted]' : scrub(item)]));
}
function record(direction, message) {
  fs.appendFileSync(wirePath, JSON.stringify({ sequence: ++sequence, at: new Date().toISOString(), pid: process.pid, direction, message: scrub(message) }) + '\n');
}
function observer(direction) {
  let pending = '';
  return new Transform({ transform(chunk, encoding, done) {
    pending += chunk.toString('utf8');
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim()) record(direction, JSON.parse(line));
    }
    done(null, chunk);
  }});
}
const input = process.stdin.pipe(observer('host-to-peer'));
const output = observer('peer-to-host');
output.pipe(process.stdout);
const stats = { pid: process.pid, parentPid: process.ppid, prompts: [], transcripts: [] };
const prompts = new Map();
let holdPages = false;
let heldPages = [];
let connection;
const agent = {
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'controlled-acp-runtime-peer', version: '1' }, authMethods: [], agentCapabilities: {} };
  },
  async newSession() { return { sessionId: randomUUID() }; },
  async loadSession() { return {}; },
  async unstable_resumeSession() { return {}; },
  async prompt(request) {
    stats.prompts.push({ sessionId: request.sessionId, prompt: request.prompt, at: new Date().toISOString() });
    await connection.sessionUpdate({ sessionId: request.sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: request.prompt.map((item) => item.text ?? '').join('') },
    }});
    return new Promise((resolve) => prompts.set(request.sessionId, resolve));
  },
  async cancel(request) { prompts.get(request.sessionId)?.({ stopReason: 'cancelled' }); prompts.delete(request.sessionId); },
  async extMethod(method, params) {
    if (method !== 'qwen/status/session/transcript') return {};
    stats.transcripts.push({ method, params, at: new Date().toISOString() });
    const page = JSON.parse(fs.readFileSync(pagePath, 'utf8'));
    if (!holdPages) return page;
    return new Promise((resolve) => heldPages.push(() => resolve(page)));
  },
};
connection = new AgentSideConnection(() => agent, ndJsonStream(Writable.toWeb(output), Readable.toWeb(input)));

async function control(command) {
  const sessionId = command.sessionId;
  switch (command.action) {
    case 'status': return { ...stats, pendingPrompts: [...prompts.keys()], heldPages: heldPages.length };
    case 'page':
      fs.writeFileSync(pagePath, JSON.stringify(command.page) + '\n');
      holdPages = command.hold === true;
      return { holdPages };
    case 'release-pages': {
      const released = heldPages.length;
      holdPages = false;
      for (const release of heldPages) release();
      heldPages = [];
      return { released };
    }
    case 'release-prompt': {
      const present = prompts.has(sessionId);
      prompts.get(sessionId)?.({ stopReason: 'end_turn' });
      prompts.delete(sessionId);
      return { released: present };
    }
    case 'start-goal':
      await connection.extNotification('_qwencode/start_turn', { sessionId, source: 'goal' });
      if (command.text) await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: command.text } } });
      return { sent: true };
    case 'start-background': {
      const result = await connection.extMethod('_qwencode/start_turn', {
        sessionId, source: 'background_notification', turnId: 'runtime-background', taskId: 'runtime-task',
        kind: 'agent', sourceTurnId: 'runtime-user', toolUseId: 'runtime-tool', label: 'Runtime background', startedAt: Date.now(),
      });
      if (command.text) await connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: command.text } } });
      return result;
    }
    case 'end-turn':
      await connection.extNotification('_qwencode/end_turn', {
        sessionId, source: command.source, reason: command.reason,
        promptId: command.promptId ?? `${sessionId}########runtime-goal`, turnId: command.turnId,
      });
      return { sent: true };
    default: throw new Error(`Unknown control action ${command.action}`);
  }
}
const server = http.createServer(async (request, response) => {
  try {
    let data = '';
    for await (const chunk of request) data += chunk;
    const command = JSON.parse(data);
    const result = await control(command);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: String(error) }));
  }
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(evidence, 'peer-ready.json'), JSON.stringify({ pid: process.pid, parentPid: process.ppid, port: server.address().port }) + '\n');
});
process.stdin.once('end', () => server.close());
process.once('SIGTERM', () => {
  record('lifecycle', { event: 'shutdown', signal: 'SIGTERM' });
  server.close();
  process.exit(0);
});
