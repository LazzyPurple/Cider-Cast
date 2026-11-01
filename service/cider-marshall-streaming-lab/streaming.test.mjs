import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createService, silenceFramesDue } from './server.mjs';
import { validateAnswer, createAudioStream, Streaming } from './streaming.mjs';
import { diagnosticRecord } from './diagnostic-log.mjs';
import { createAudioBridge } from './audio-bridge.mjs';

test('contre-pression : distingue blocage de 500 ms et volume de PCM, sans faux arrêt après drain différé', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  t.mock.method(performance, 'now', () => Date.now());
  const stdin = new EventEmitter(); stdin.writableLength = 65536; stdin.write = () => false;
  const events = []; let drains = 0;
  const transport = Object.assign(Object.create(Streaming.prototype), {
    ready: true, helper: { stdin }, pending: new Set(),
    hooks: { drain: () => drains++, error: message => events.push(message), diagnostic: (event, data) => events.push({ event, ...data }) },
  });
  assert.equal(transport.write(Buffer.alloc(65536)), false);
  t.mock.timers.tick(400); assert.equal(events.length, 0);
  stdin.writableLength = 0; stdin.emit('drain');
  assert.equal(drains, 1);
  t.mock.timers.tick(200); assert.equal(events.length, 0);
  stdin.writableLength = 65536; transport.write(Buffer.alloc(65536));
  stdin.writableLength = 0; t.mock.timers.tick(500);
  assert.equal(events.length, 0); assert.equal(drains, 2); assert.equal(stdin.listenerCount('drain'), 0);
  stdin.writableLength = 65536;
  assert.equal(transport.write(Buffer.alloc(65536)), false);
  t.mock.timers.tick(500);
  assert.equal(events[0].event, 'sender_input_stalled');
  assert.ok(events[0].elapsedMs >= 500);
  assert.equal(events[1], 'L’émetteur audio ne consomme plus le son. Retour sur le PC.');
});

test('retour PC immédiat : ne dépend pas de la fermeture réseau Cast ; récupération explicite sans session', async () => {
  let hooks, transport, local = true, release, blocked = false, finishing = false;
  class FakeTransport {
    constructor(device, callbacks) { this.hooks = callbacks; this.stats = {}; transport = this; }
    async open() { this.ready = true; }
    write() { return true; }
    async close() { if (finishing) return; blocked = true; await new Promise(resolve => release = resolve); }
  }
  const token = 'f'.repeat(64);
  const service = createService({ endpointId: 'test-only', token }, { discover: async () => ({}), Streaming: FakeTransport, createAudioBridge(config, callbacks) {
    hooks = callbacks; return { ready: Promise.resolve(), available: true, routed: true, get local() { return local; }, setLocal(value) { local = value; }, resume() {}, close: async () => {} };
  } });
  await new Promise(resolve => service.control.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + service.control.address().port;
  const req = (route, data) => fetch(base + route, { method: data ? 'POST' : 'GET', headers: { 'X-Marshall-Token': token }, body: data ? JSON.stringify(data) : undefined });
  try {
    const start = await (await req('/start', { version: '1.0.0-rc.2' })).json();
    hooks.audio(Buffer.alloc(7680), .1); transport.hooks.stats({ feedback: 1, feedbackAgeMs: 1 });
    assert.equal(local, false);
    const stopped = req('/local', {});
    for (let n = 0; n < 20 && !blocked; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(blocked, true); assert.equal(local, true);
    release(); assert.equal((await stopped).status, 200);
    const status = await (await req('/status')).json(); assert.equal(status.active, false); assert.equal(status.output, 'pc');
    assert.equal((await req('/local', {})).status, 200);
    assert.equal((await fetch(base + '/local', { method: 'POST', body: '{}' })).status, 403);
    assert.ok(start.id);
  } finally { finishing = true; release?.(); await service.close(); service.control.closeAllConnections(); await new Promise(resolve => service.control.close(resolve)); }
});

test('capture → émetteur lent : rafale supérieure à 500 ms transférée intégralement, file basse et aucune copie audio ajoutée', async () => {
  const native = new EventEmitter(); native.stdin = new PassThrough(); native.stdout = new PassThrough(); native.stderr = new PassThrough();
  const received = [], errors = [];
  const stdin = new Writable({ highWaterMark: 16384, write(data, encoding, done) { received.push(Buffer.from(data)); setTimeout(done, 10); } });
  let bridge, maximum = 0;
  const transport = Object.assign(Object.create(Streaming.prototype), {
    ready: true, helper: { stdin }, pending: new Set(),
    hooks: { drain: () => bridge.resume(), error: message => errors.push(message) },
  });
  bridge = createAudioBridge({ ffmpeg: process.execPath, endpointId: 'test' }, {
    audio(data) { const writable = transport.write(data); maximum = Math.max(maximum, stdin.writableLength); return writable; },
    error: message => errors.push(message), closed() {},
  }, exe => {
    if (exe.endsWith('capture.exe')) return native;
    const player = new EventEmitter(); player.stdin = new PassThrough(); player.stderr = new PassThrough(); player.kill = () => {}; return player;
  });
  bridge.setLocal(false);
  const blocks = [.1, .2, .3, .4].map(value => { const pcm = Buffer.alloc(65536); for (let i = 0; i < pcm.length; i += 4) pcm.writeFloatLE(value, i); return pcm; });
  try {
    for (const block of blocks) native.stdout.write(block);
    await bridge.ready;
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Transfer timed out')), 2000);
      const check = () => { if (received.length === blocks.length && stdin.writableLength === 0) { clearTimeout(deadline); resolve(); } else setTimeout(check, 5); }; check();
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(Buffer.concat(received), Buffer.concat(blocks));
    assert.equal(maximum, 65536);
    assert.equal(transport.failure, undefined);
  } finally {
    const ended = bridge.close(); native.emit('close', 0); await ended; stdin.end();
    clearTimeout(transport.queueTimer);
  }
});

test('file : aucun tampon ajouté, refus à 500 ms en comptant le bloc entrant et diagnostic numérique', () => {
  const events = [], writes = [];
  const transport = Object.assign(Object.create(Streaming.prototype), {
    ready: true, helper: { stdin: { writableLength: 0, write: data => writes.push(data.length) } },
    hooks: { diagnostic: (event, data) => events.push(diagnosticRecord(event, { ...data, token: 'secret' })) },
  });
  transport.write(Buffer.alloc(7680));
  assert.deepEqual(writes, [7680]); assert.equal(events.length, 0);
  transport.helper.stdin.writableLength = 131072;
  assert.throws(() => transport.write(Buffer.alloc(65536)), /500 ms/);
  assert.equal(writes.length, 1);
  assert.equal(events[0].event, 'input_queue_limit');
  assert.equal(events[0].queueMs, 131072 / 384);
  assert.equal(events[0].incomingMs, 65536 / 384);
  assert.equal(events[0].projectedQueueMs, 512);
  assert.ok(events[0].inputGapMs >= 0);
  assert.ok(!JSON.stringify(events).includes('secret'));
});

test('connecter en pause : attente durable, silence de maintien, puis lecture ou annulation sans route tardive', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  t.mock.method(performance, 'now', () => Date.now());
  for (const action of ['play', 'cancel']) {
    let hooks, resolveReady, rejectReady, routed = false, local = true, closes = 0, writes = 0, silentFrames = 0, transport;
    class FakeTransport {
      constructor(device, callbacks) { this.hooks = callbacks; this.queueMs = 0; this.stats = {}; transport = this; }
      async open() { this.ready = true; }
      write(data) { if (!routed) { assert.ok(data.every(value => value === 0)); silentFrames += data.length / 7680; } writes++; return !this.blocked; }
      async close() { this.ready = false; }
    }
    const token = 'e'.repeat(64);
    const service = createService({ endpointId: 'test-only', token, target: 'test' }, { discover: async () => ({}), Streaming: FakeTransport,
      createAudioBridge(config, callbacks) {
        hooks = callbacks;
        return { ready: new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }),
          get routed() { return routed; }, get local() { return local; },
          setLocal(value) { local = value; },
          async close() { closes++; rejectReady(new Error('Annulée')); callbacks.closed(false); } };
      } });
    await new Promise(resolve => service.control.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + service.control.address().port;
    const req = (route, data) => fetch(base + route, { method: data ? 'POST' : 'GET', headers: { 'X-Marshall-Token': token }, body: data ? JSON.stringify(data) : undefined });
    try {
      const start = await (await req('/start', { version: '1.0.0-rc.2' })).json();
      assert.ok(start.id); // Responds before the unresolved capture is ready.
      transport.hooks.stats({ feedback: 1, feedbackAgeMs: 1 }); assert.equal(local, true);
      transport.blocked = true; t.mock.timers.tick(100);
      assert.equal(writes, 1); assert.equal(silentFrames, 5);
      transport.blocked = false; transport.hooks.drain();
      t.mock.timers.tick(59900);
      const waiting = await (await req('/status')).json();
      assert.equal(waiting.phase, 'waiting'); assert.equal(waiting.output, 'direct');
      assert.equal(waiting.error, ''); assert.equal(waiting.active, true); assert.equal(silentFrames, 3000);
      if (action === 'play') {
        routed = true; resolveReady(); await new Promise(resolve => setImmediate(resolve));
        const pcm = Buffer.alloc(8); pcm.writeFloatLE(.25); hooks.audio(pcm, .25);
        transport.hooks.stats({ feedback: 2, feedbackAgeMs: 1 });
        const playing = await (await req('/status')).json(); assert.equal(playing.phase, 'casting'); assert.equal(local, false);
      }
      await req('/stop?id=' + start.id, {});
      const after = await (await req('/status')).json();
      assert.equal(after.active, false); assert.equal(after.error, ''); assert.equal(after.needsRestart, false);
      if (action === 'cancel') { assert.equal(closes, 1); assert.equal(routed, false); assert.equal(after.output, 'direct'); }
      else { assert.equal(closes, 0); assert.equal(local, true); }
      const stoppedAt = writes; t.mock.timers.tick(60000); assert.equal(writes, stoppedAt);
    } finally { await service.close(); service.control.closeAllConnections(); await new Promise(resolve => service.control.close(resolve)); }
  }
});

test('silence de maintien : horloge conservée avec callbacks espacés de 31,25 ms et rattrapage borné', () => {
  let sent = 0;
  for (let tick = 1; tick <= 1920; tick++) sent += silenceFramesDue(tick * 31.25, sent);
  assert.equal(sent, 3000); // One minute of 20 ms frames, despite the slower callbacks.
  assert.equal(silenceFramesDue(19, 0), 0);
  assert.equal(silenceFramesDue(20, 0), 1);
  assert.equal(silenceFramesDue(60000, 0), 10);
  assert.equal(silenceFramesDue(20, 2), 0);
});

test('offres Marshall : SSRC non nul sur 31 bits et clés éphémères', () => {
  const ids = new Set(), keys = new Set();
  for (let i = 0; i < 1000; i++) {
    const stream = createAudioStream(400);
    assert.ok(Number.isInteger(stream.ssrc) && stream.ssrc > 0 && stream.ssrc < 0x7fffffff);
    assert.equal(stream.codecName, 'opus'); assert.equal(stream.rtpPayloadType, 96);
    assert.equal(stream.channels, 2); assert.equal(stream.targetDelay, 400);
    assert.match(stream.aesKey, /^[a-f0-9]{32}$/); assert.match(stream.aesIvMask, /^[a-f0-9]{32}$/);
    ids.add(stream.ssrc); keys.add(stream.aesKey);
  }
  assert.ok(ids.size > 990); assert.equal(keys.size, 1000);
  assert.throws(() => createAudioStream(-1));
});

test('annuler pendant la découverte : état visible, aucun lecteur ni flux orphelin', async () => {
  let release; const gate = new Promise(resolve => release = resolve); let captures = 0;
  const token = 'c'.repeat(64);
  const service = createService({ endpointId: 'test-only', token, target: 'test' }, { discover: async () => { await gate; return {}; }, createAudioBridge() { captures++; }, Streaming: class {} });
  await new Promise(resolve => service.control.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + service.control.address().port;
  const req = (url, body) => fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'X-Marshall-Token': token }, body: body ? JSON.stringify(body) : undefined });
  try {
    const start = req('/start', { version: '1.0.0-rc.2' });
    let status;
    for (let n = 0; n < 100; n++) { status = await (await req('/status')).json(); if (status.active) break; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(status.phase, 'connecting'); assert.ok(status.id); assert.equal(status.output, 'direct');
    assert.equal((await req('/stop?id=' + status.id, {})).status, 200);
    release(); assert.equal((await start).status, 409); assert.equal(captures, 0);
    const after = await (await req('/status')).json(); assert.equal(after.phase, 'pc'); assert.equal(after.error, '');
  } finally { release(); await service.close(); service.control.closeAllConnections(); await new Promise(resolve => service.control.close(resolve)); }
});

test('retour PC même si la fermeture Cast échoue, sourdine seulement après retour récent', async () => {
  let hooks, transport, local = true;
  class FakeTransport {
    constructor(device, callbacks) { this.hooks = callbacks; this.stats = {}; transport = this; }
    async open() { this.ready = true; }
    write() {}
    async close() { throw new Error('closed socket'); }
  }
  const token = 'd'.repeat(64);
  const service = createService({ endpointId: 'test-only', token, target: 'test' }, { discover: async () => ({}), Streaming: FakeTransport,
    createAudioBridge(config, callbacks) { hooks = callbacks; return { ready: Promise.resolve(), get local() { return local; }, setLocal(value) { local = value; }, close: async () => {} }; } });
  await new Promise(resolve => service.control.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + service.control.address().port;
  const req = (url, body) => fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'X-Marshall-Token': token }, body: body ? JSON.stringify(body) : undefined });
  try {
    const start = await (await req('/start', { version: '1.0.0-rc.2' })).json();
    hooks.audio(Buffer.alloc(8), .1);
    transport.hooks.stats({ feedback: 1, feedbackAgeMs: 6000 }); assert.equal(local, true);
    transport.hooks.stats({ feedback: 2, feedbackAgeMs: 2 }); assert.equal(local, false);
    await req('/stop?id=' + start.id, {}); assert.equal(local, true);
    const status = await (await req('/status')).json(); assert.equal(status.phase, 'pc'); assert.equal(status.output, 'pc'); assert.match(status.error, /fermée/);
  } finally { await service.close(); service.control.closeAllConnections(); await new Promise(resolve => service.control.close(resolve)); }
});

test('refus Cast : motif lisible, détails sensibles masqués', () => {
  assert.throws(() => validateAnswer({ type: 'ANSWER', result: 'error', error: { code: -2, description: 'Invalid or missing codec on first OFFER' } }), /code -2.*Invalid or missing codec/);
  assert.throws(() => validateAnswer({ type: 'ANSWER', result: 'error', error: { description: 'x'.repeat(2) + 'a'.repeat(32) } }), e => e.message.includes('[masqué]') && !e.message.includes('a'.repeat(32)));
});

test('réponse Cast : refus, sélection, port, contraintes', () => {
  const answer = { type: 'ANSWER', result: 'ok', answer: { udpPort: 1234, sendIndexes: [0], ssrcs: [42] } };
  assert.equal(validateAnswer(answer).port, 1234);
  for (const field of [{ udpPort: 0 }, { sendIndexes: [1] }, { ssrcs: [] }, { constraints: { audio: { maxChannels: 1 } } }]) assert.throws(() => validateAnswer({ ...answer, answer: { ...answer.answer, ...field } }));
  assert.throws(() => validateAnswer({ ...answer, result: 'error' }));
});

test('contrôleur : capture Cider réutilisée, retour PC, anciennes sessions et accès refusés', async () => {
  let hooks, local = true, closed = false, recovered = false, transport, releaseDiscovery, resumes = 0;
  const launches = [], diagnostics = [];
  class FakeTransport {
    constructor(device, callbacks) { this.hooks = callbacks; this.stats = {}; this.queueMs = 0; transport = this; }
    async open() { this.ready = true; }
    write(data) { this.bytes = (this.bytes ?? 0) + data.length; return false; }
    async close() { this.ready = false; this.stopped = true; }
  }
  const token = 'a'.repeat(64), config = { token, endpointId: 'test-only', target: 'test', localAddress: '127.0.0.1' };
  let discoveryCount = 0;
  const service = createService(config, { Streaming: FakeTransport, discover: async () => { if (++discoveryCount === 2) await new Promise(resolve => releaseDiscovery = resolve); return { host: '127.0.0.1', port: 8009 }; }, createAudioBridge(cfg, callbacks, launch) { const capture = launch(fileURLToPath(new URL('../cider-marshall-isolated/native/capture.exe', import.meta.url)), [], {}); capture.stderr.emit('data', Buffer.from('CAPTURE 12345\n')); hooks = callbacks; return { ready: Promise.resolve(), get local() { return local; }, setLocal(value) { local = value; }, resume() { resumes++; }, async close() { closed = true; } }; }, spawn(exe) { launches.push(exe); recovered = true; const p = new EventEmitter(); p.stderr = new EventEmitter(); p.stderr.resume = () => {}; setImmediate(() => p.emit('exit', 0)); return p; } }, (event, data) => { const entry = diagnosticRecord(event, data); if (entry) diagnostics.push(entry); });
  await new Promise(r => service.control.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + service.control.address().port;
  const req = (url, data) => fetch(base + url, { method: data ? 'POST' : 'GET', headers: { 'X-Marshall-Token': token }, body: data ? JSON.stringify(data) : undefined });
  try {
    assert.equal((await fetch(base + '/status')).status, 403);
    assert.equal((await fetch(base + '/diagnostic', { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await req('/diagnostic', { sequence: 1, trigger: 'error', token: 'secret', media: [{ slot: 1, currentTime: .1, errorCode: 3, src: 'secret' }] })).status, 200);
    assert.equal(diagnostics.find(entry => entry.event === 'playback').media[0].errorCode, 3);
    assert.ok(!JSON.stringify(diagnostics).includes('secret'));
    assert.equal((await req('/start', { version: '1.0.0-rc.2', delayMs: -1 })).status, 400);
    assert.equal((await req('/recover', {})).status, 200); assert.ok(recovered);
    const started = await (await req('/start', { version: '1.0.0-rc.2' })).json();
    assert.ok(launches.every(exe => exe === fileURLToPath(new URL('./native/capture.exe', import.meta.url))));
    assert.ok(diagnostics.some(entry => entry.event === 'capture_source' && entry.pid === 12345));
    assert.equal(hooks.audio(Buffer.alloc(7680), .1), false); assert.equal(transport.bytes, 7680); assert.equal(local, true);
    const firstTransport = transport;
    transport.hooks.drain(); assert.equal(resumes, 1);
    transport.stats = { feedback: 1, feedbackAgeMs: 1 }; transport.hooks.stats(transport.stats); assert.equal(local, false);
    assert.equal((await req('/stop?id=expired', {})).status, 409);
    await req('/stop?id=' + started.id, {}); assert.equal(local, true); assert.equal(closed, false); assert.equal(transport.stopped, true); assert.equal(resumes, 2);
    const secondStart = req('/start', { version: '1.0.0-rc.2' });
    for (let n = 0; n < 100 && !releaseDiscovery; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(releaseDiscovery);
    assert.doesNotThrow(() => hooks.audio(Buffer.alloc(7680), .1));
    releaseDiscovery();
    const second = await (await secondStart).json(); assert.notEqual(second.id, started.id);
    firstTransport.hooks.drain(); assert.equal(resumes, 2);
    transport.hooks.error('test disconnect'); await new Promise(r => setTimeout(r, 10));
    const status = await (await req('/status')).json(); assert.equal(status.active, false); assert.equal(status.error, 'test disconnect'); assert.equal(local, true);
    hooks.error('Le relais PC est saturé. Relancez Cider.');
    const afterRelayError = await (await req('/status')).json();
    assert.equal(afterRelayError.error, 'test disconnect');
    assert.ok(diagnostics.some(entry => entry.event === 'secondary_error' && entry.code === 'PC_RELAY_SATURATED'));
  } finally { await service.close(); service.control.closeAllConnections(); await new Promise(r => service.control.close(r)); }
});
