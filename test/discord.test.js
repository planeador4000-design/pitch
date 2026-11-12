'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { DiscordClient } = require('../src/main/discord');

// A minimal fake Discord IPC server: enough of the handshake/frame protocol to drive DiscordClient.
function fakeDiscordIpc(pipePath) {
  const OP = { HANDSHAKE: 0, FRAME: 1 };
  function encode(op, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.alloc(8);
    header.writeUInt32LE(op, 0);
    header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body]);
  }
  const received = [];
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const op = buf.readUInt32LE(0);
        const len = buf.readUInt32LE(4);
        if (buf.length < 8 + len) break;
        const body = JSON.parse(buf.subarray(8, 8 + len).toString('utf8'));
        buf = buf.subarray(8 + len);
        received.push(body);
        if (op === OP.HANDSHAKE) {
          socket.write(encode(OP.FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } }));
        } else if (op === OP.FRAME && body.cmd === 'SET_ACTIVITY') {
          socket.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', evt: null, nonce: body.nonce, data: body.args }));
        }
      }
    });
  });
  server.listen(pipePath);
  return { server, received };
}

test('connects, completes the handshake, and reports READY', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-discord-'));
  const pipePath = path.join(dir, 'discord-ipc-0');
  const { server, received } = fakeDiscordIpc(pipePath);
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const originalTmp = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  t.after(() => {
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
  });
  if (process.platform === 'win32') return; // pipe path scheme differs; this test targets the Unix socket path.

  const client = new DiscordClient({ clientId: 'test-client-id' });
  const statuses = [];
  client.on((s) => statuses.push(s));
  client.start();

  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (client.ready) {
        clearInterval(check);
        resolve();
      }
    }, 20);
  });

  assert.equal(client.status().connected, true);
  assert.equal(received[0].client_id, 'test-client-id');
  client.stop();
});

test('setActivity is queued until the connection is ready, then sent', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-discord-'));
  const pipePath = path.join(dir, 'discord-ipc-0');
  const { server, received } = fakeDiscordIpc(pipePath);
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const originalTmp = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  t.after(() => {
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
  });
  if (process.platform === 'win32') return;

  const client = new DiscordClient({ clientId: 'abc' });
  client.setActivity({ title: 'Space Cat', startedAt: Date.now() });
  client.start();

  await new Promise((resolve) => setTimeout(resolve, 300));
  const activityCall = received.find((r) => r.cmd === 'SET_ACTIVITY');
  assert.ok(activityCall, 'expected a SET_ACTIVITY frame to have been sent');
  assert.match(activityCall.args.activity.details, /Space Cat/);
  client.stop();
});

test('without Discord running, status stays disconnected instead of throwing', async () => {
  const client = new DiscordClient({ clientId: 'no-server-here' });
  client.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(client.status().connected, false);
  client.stop();
});

test('an unconfigured client (no clientId) never tries to connect', () => {
  const client = new DiscordClient({});
  assert.equal(client.configured, false);
  client.start();
  assert.equal(client.socket, null);
});

test('login uses PKCE and never sends a client secret', async (t) => {
  const http = require('node:http');
  const crypto = require('node:crypto');
  const realFetch = global.fetch;
  let tokenBody = null;
  global.fetch = async (url, opts) => {
    if (String(url).endsWith('/oauth2/token')) {
      tokenBody = new URLSearchParams(String(opts.body));
      return { ok: true, status: 200, json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: '1', username: 'tester', avatar: null }) };
  };
  t.after(() => {
    global.fetch = realFetch;
  });

  let saved = null;
  const client = new DiscordClient({ clientId: 'cid', redirectPort: 28931, getToken: () => saved, setToken: (tok) => (saved = tok) });
  let authUrl = null;
  const user = await client.authorize({
    openExternal: async (u) => {
      authUrl = new URL(u);
      // Play the part of Discord's redirect back to Pitch's local callback.
      const cb = `http://127.0.0.1:28931/callback?code=thecode&state=${authUrl.searchParams.get('state')}`;
      setTimeout(() => http.get(cb, (res) => res.resume()), 20);
    },
  });

  assert.equal(user.username, 'tester');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  const verifier = tokenBody.get('code_verifier');
  assert.ok(verifier && verifier.length >= 43, 'verifier must be 43+ chars per RFC 7636');
  assert.equal(authUrl.searchParams.get('code_challenge'), crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(tokenBody.has('client_secret'), false);
  assert.equal(tokenBody.get('code'), 'thecode');
});
