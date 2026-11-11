'use strict';

// The injector is how Pitch reaches inside a running game without ever touching its
// files on disk. Verified by hand before writing this (see docs/mod-research.md): games
// exported by the TurboWarp Packager — the standard Scratch-to-desktop exporter — are
// Electron or NW.js apps, i.e. real Chromium processes. Any Chromium process accepts the
// same --remote-debugging-port flag Pitch itself uses during development, and once that
// port is open, the Chrome DevTools Protocol (CDP) lets an external process evaluate
// JavaScript inside the game's own page — the same mechanism Chrome's own DevTools use.
//
// This file owns exactly that connection. It does not know anything about Scratch,
// sprites, or mods — see detector.js and host.js for that. Its only jobs are: find a free
// port, talk to the game's debugger, and hand back a thin evaluate() to whoever asked.
// Pitch's launcher starts the process (it knows the per-OS details), with the port flag.

const net = require('node:net');
const CDP = require('chrome-remote-interface');

class InjectorError extends Error {
  constructor(message, code = 'INJECTOR') {
    super(message);
    this.name = 'InjectorError';
    this.code = code;
  }
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Waits for the game's debugger endpoint to come up (the process needs a moment to start
// listening after spawn) and returns the list of inspectable targets.
async function waitForTargets(port, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await CDP.List({ port, host: '127.0.0.1' });
      if (targets.length) return targets;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new InjectorError(
    'No se pudo conectar con el proceso del juego para activar los mods. Puede que no sea una app compatible (Electron/NW.js).',
    'NO_TARGET',
  );
}

// Picks the target that is actually the game's own window, not a devtools-internal page,
// a hidden background page, or (on multi-window games) a secondary popup.
function pickMainTarget(targets) {
  const pages = targets.filter((t) => t.type === 'page' && !/^devtools:/.test(t.url));
  if (!pages.length) throw new InjectorError('El juego no tiene ninguna ventana visible a la que conectarse.', 'NO_PAGE');
  const real = pages.find((t) => /^(file|https?):/.test(t.url));
  return real || pages[0];
}

class GameSession {
  constructor({ client, port, targetId }) {
    this.client = client;
    this.port = port;
    this.targetId = targetId;
    this.closed = false;
  }

  // Runs `expression` inside the game's page and returns its value. Throws InjectorError
  // if the game's own code threw, so callers can tell "my code is wrong" apart from
  // "the connection died".
  async evaluate(expression, { awaitPromise = false } = {}) {
    if (this.closed) throw new InjectorError('La conexión con el juego ya se cerró.', 'CLOSED');
    let result;
    try {
      result = await this.client.Runtime.evaluate({
        expression,
        awaitPromise,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      });
    } catch (err) {
      throw new InjectorError(`Fallo al comunicar con el juego: ${err.message}`, 'EVAL_TRANSPORT');
    }
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
      throw new InjectorError(desc || 'El juego devolvió un error al ejecutar el mod.', 'EVAL_THROWN');
    }
    return result.result ? result.result.value : undefined;
  }

  // Lets the game's page call back into Pitch: installs window[name](payload) through
  // Runtime.addBinding and routes each call to `handler`.
  async onBinding(name, handler) {
    await this.client.Runtime.addBinding({ name });
    this.client.Runtime.bindingCalled(({ name: calledName, payload }) => {
      if (calledName === name) handler(payload);
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.close();
    } catch {
      /* already gone */
    }
  }
}

// Connects to a game that was ALREADY started with --remote-debugging-port=<port>.
async function connectToGame({ port, timeoutMs = 15000 }) {
  const targets = await waitForTargets(port, { timeoutMs });
  const target = pickMainTarget(targets);
  let client;
  try {
    client = await CDP({ port, target: target.id });
    await client.Runtime.enable();
  } catch (err) {
    throw new InjectorError(`No se pudo activar el modo de mods: ${err.message}`, 'CONNECT_FAILED');
  }
  return new GameSession({ client, port, targetId: target.id });
}

module.exports = { connectToGame, findFreePort, InjectorError, waitForTargets, pickMainTarget };
