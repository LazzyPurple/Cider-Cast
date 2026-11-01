import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createAudioBridge } from './audio-bridge.mjs';


function child() {
  const process = new EventEmitter();
  process.bytes = 0; process.killed = false;
  process.stdin = new Writable({ write(chunk, encoding, done) { process.bytes += chunk.length; done(); } });
  process.stdout = new PassThrough(); process.stderr = new PassThrough();
  process.kill = () => { process.killed = true; process.emit('exit', 0); process.emit('close', 0); };
  return process;
}
function harness(onAudio) {
  const children = [], errors = [], samples = [], details = [];
  const bridge = createAudioBridge({ ffmpeg: process.execPath, endpointId: 'test' }, {
    audio: (data, peak) => { samples.push({ length: data.length, peak }); return onAudio?.(data, peak); },
    error: (message, info) => { errors.push(message); details.push(info); }, closed() {},
  }, (exe, args) => { const p = child(); children.push({ exe, args, p }); return p; });
  const native = children[0].p;
  return { bridge, children, native, errors, samples, details, async close() { const end = bridge.close(); native.emit('exit', 0); native.emit('close', 0); await end; } };
}

test('rafale : suspend la capture sur contre-pression Cast puis reprend sans perdre ni réordonner le PCM', async () => {
  const received = [];
  const h = harness(data => { received.push(Buffer.from(data)); return received.length !== 1; });
  h.bridge.setLocal(false);
  try {
    const blocks = [.1, .2, .3, .4].map(value => { const pcm = Buffer.alloc(65536); for (let i = 0; i < pcm.length; i += 4) pcm.writeFloatLE(value, i); return pcm; });
    for (const block of blocks) h.native.stdout.write(block);
    await h.bridge.ready;
    assert.equal(received.length, 1);
    assert.equal(h.native.stdout.isPaused(), true);
    h.bridge.resume();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(Buffer.concat(received), Buffer.concat(blocks));
    assert.equal(h.errors.length, 0);
  } finally { await h.close(); }
});

test('attente sans musique : pas de délai expiré ni routage ; fermeture annule la sélection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); const ended = assert.rejects(h.bridge.ready, /arrêté/);
  h.native.stderr.write('STAGE selection\n');
  t.mock.timers.tick(120000);
  assert.equal(h.errors.length, 0); assert.equal(h.bridge.routed, false);
  assert.equal(h.native.stdin.writableEnded, false);
  await h.close(); await ended;
  assert.equal(h.native.stdin.writableEnded, true);
});

test('après sélection musicale : le délai de première capture reste borné', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); const failed = assert.rejects(h.bridge.ready, /Aucun flux reçu/);
  h.native.stderr.write('STAGE selection\n'); t.mock.timers.tick(120000);
  h.native.stderr.write('STAGE route\n'); assert.equal(h.bridge.routed, true);
  t.mock.timers.tick(22001); await failed;
  assert.equal(h.errors.length, 1); await h.close();
});

test('PC → Cast → PC : une seule capture Windows, aucune restauration intermédiaire', async () => {
  const h = harness();
  try {
    const pcm = Buffer.alloc(16); pcm.writeFloatLE(.25);
    h.native.stdout.write(pcm.subarray(0, 3)); h.native.stdout.write(pcm.subarray(3));
    await h.bridge.ready;
    assert.equal(h.children[1].p.bytes, 16);
    assert.equal(h.samples[0].peak, .25);
    h.bridge.setLocal(false);
    assert.equal(h.children[1].p.killed, true);
    assert.equal(h.native.stdin.writableEnded, false);
    h.native.stdout.write(pcm);
    h.bridge.setLocal(true); h.bridge.setLocal(true);
    h.native.stdout.write(pcm);
    assert.equal(h.children.length, 3);
    assert.equal(h.children[2].p.bytes, 16);
    assert.equal(h.native.stdin.writableEnded, false);
    assert.equal(h.errors.length, 0);
  } finally { await h.close(); }
  assert.equal(h.native.stdin.writableEnded, true);
});

test('relais PC lent : les deux sorties doivent être libres avant de reprendre la capture', async () => {
  const children = [], received = []; let releasePC, forwarded = 0;
  const bridge = createAudioBridge({ ffmpeg: process.execPath, endpointId: 'test' }, { audio() { return ++forwarded !== 1; }, error(message) { throw Error(message); }, closed() {} }, () => {
    const p = child();
    if (children.length === 1) p.stdin = new Writable({ highWaterMark: 8, write(data, encoding, done) {
      received.push(Buffer.from(data)); if (received.length === 1) releasePC = done; else done();
    } });
    children.push(p); return p;
  });
  try {
    const pcm = Buffer.alloc(16); pcm.writeFloatLE(.25);
    children[0].stdout.write(pcm); children[0].stdout.write(pcm);
    await bridge.ready; assert.equal(forwarded, 1);
    bridge.resume(); assert.equal(children[0].stdout.isPaused(), true);
    releasePC(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(forwarded, 2); assert.equal(Buffer.concat(received).length, 32);
  } finally { const end = bridge.close(); children[0].emit('close', 0); await end; }
});

test('stderr Windows fragmenté : attend le code complet avant de fermer la capture', async () => {
  const h = harness(); const rejected = assert.rejects(h.bridge.ready, /Lancez un morceau audible/);
  h.native.stderr.write('ERROR 0x');
  assert.equal(h.errors.length, 0); assert.equal(h.native.stdin.writableEnded, false);
  h.native.stderr.write('80070490\r'); assert.equal(h.errors.length, 0);
  h.native.stderr.write('\n'); await rejected;
  assert.equal(h.errors.length, 1); assert.equal(h.native.stdin.writableEnded, true);
  await h.close();
});

test('mesures capture : compteurs numériques fragmentés, sans données audio ou texte libre', async () => {
  const entries = [], children = [];
  const bridge = createAudioBridge({ ffmpeg: process.execPath, endpointId: 'test' }, { audio() {}, error() {}, closed() {}, diagnostic: (event, data) => entries.push({ event, ...data }) }, () => { const p = child(); children.push(p); return p; });
  const ended = assert.rejects(bridge.ready);
  children[0].stderr.write('CAPTURE_STATS 48000 2 0 ');
  children[0].stderr.write('480 16 32\n');
  assert.deepEqual(entries[0], { event: 'capture_stats', capturedFrames: 48000, discontinuities: 2, timestampErrors: 0, missingFrames: 480, maxProbeMs: 16, maxWriteMs: 32 });
  children[0].stderr.write('CAPTURE_TIMING 700 20 ');
  assert.equal(entries.length, 1);
  children[0].stderr.write('100 1\nCAPTURE_TIMING 1 2 3 9\nCAPTURE_TIMING private 2 3 1\n');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[1], { event: 'capture_timing', maxPacketGapMs: 700, maxPacketAgeMs: 20, qpcPackets: 100, mmcssActive: 1 });
  const closing = bridge.close(); children[0].emit('close', 0); await closing; await ended;
});

test('stderr Windows : conserve le HRESULT complet et l’étape sans audio', async () => {
  const h = harness(); const rejected = assert.rejects(h.bridge.ready, /0x88890004/);
  h.native.stderr.write('STAGE initialize\nERROR 0x8889');
  assert.equal(h.errors.length, 0);
  h.native.stderr.write('0004\n'); await rejected;
  assert.match(h.errors[0], /0x88890004/); await h.close();
});

test('sortie réservée définie sortie Windows par défaut : message utile, aucune obligation de redémarrer Cider', async () => {
  const h = harness(); const rejected = assert.rejects(h.bridge.ready, /communications Windows/);
  h.native.stderr.write('STAGE default-check\nERROR 0x80070005\n'); await rejected;
  assert.equal(h.details[0].needsRestart, false);
  assert.ok(!h.errors[0].includes('Relancez'));
  await h.close();
});
test('sortie réservée absente, ambiguë ou occupée : refus avant routage, réessai sans redémarrage', async () => {
  for (const [stage, code, message] of [['endpoint','0x8007048f',/absente/],['endpoint','0x80070034',/Plusieurs sorties/],['selection','0x800700aa',/utilisée/]]) {
    const h = harness(); const rejected = assert.rejects(h.bridge.ready, message);
    h.native.stderr.write(`STAGE ${stage}\nERROR ${code}\n`); await rejected;
    assert.equal(h.bridge.routed, false); assert.equal(h.details[0].needsRestart, false); await h.close();
  }
});

test('sources réellement ambiguës avant routage : refus lisible et nouvelle tentative possible sans redémarrage', async () => {
  const h = harness(); const rejected = assert.rejects(h.bridge.ready, /Plusieurs sources audio Cider/);
  h.native.stderr.write('STAGE selection\nERROR 0x80070034\n'); await rejected;
  assert.equal(h.bridge.routed, false); assert.equal(h.details[0].needsRestart, false);
  assert.ok(!h.errors[0].includes('Relancez'));
  await h.close();
});

test('signal invalide ou panne du lecteur PC : erreur explicite et libération du module', async () => {
  for (const failure of ['pcm', 'player']) {
    const h = harness();
    const rejected = assert.rejects(h.bridge.ready);
    if (failure === 'pcm') { const pcm = Buffer.alloc(8); pcm.writeFloatLE(NaN); h.native.stdout.write(pcm); }
    else h.children[1].p.emit('error', new Error('spawn failed'));
    await rejected;
    assert.equal(h.native.stdin.writableEnded, true);
    assert.equal(h.errors.length, 1);
    assert.throws(() => h.bridge.setLocal(true), /arrêté/);
    await h.close();
  }
});

test('fermeture de Cider : arrêt du lecteur PC et fin de vie du relais', async () => {
  const h = harness(); const rejected = assert.rejects(h.bridge.ready);
  h.native.emit('exit', 0); h.native.emit('close', 0); await rejected; await h.bridge.ended;
  assert.equal(h.children[1].p.killed, true);
  assert.equal(h.errors.length, 0);
});

test('restauration différée après fermeture normale : aucune fausse panne du lecteur', async () => {
  const h = harness(); const rejected = assert.rejects(h.bridge.ready);
  h.native.stderr.write('RESTORE_PENDING\n');
  h.native.emit('close', 0); await rejected; await h.bridge.ended;
  assert.equal(h.errors.length, 0);
});
