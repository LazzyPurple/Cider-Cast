import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackDiagnostic } from './playback-diagnostic.js';

function doc(media = [], frames = []) {
  const listeners = new Map();
  return { hidden: false, listeners,
    querySelectorAll: selector => selector === 'audio,video' ? media : frames,
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: type => listeners.delete(type) };
}
test('sonde passive : progression, erreur éphémère et iframe ; aucune lecture de URL ou commande audio', () => {
  const audio = { tagName: 'AUDIO', currentTime: .8, paused: false, ended: false, seeking: false, readyState: 4, networkState: 2, error: null };
  for (const key of ['src', 'currentSrc', 'title', 'play', 'pause', 'captureStream', 'setSinkId']) Object.defineProperty(audio, key, { get() { throw new Error('Accès interdit'); } });
  const frame = doc([audio]), blocked = { get contentDocument() { throw new Error('Cross-origin'); } };
  const root = doc([], [{ contentDocument: frame }, blocked]);
  const sent = [], probe = createPlaybackDiagnostic(root, data => sent.push(data));
  probe.sample(); audio.currentTime = .1; audio.error = { code: 3, message: 'secret' };
  frame.listeners.get('error')({ type: 'error', target: audio });
  assert.equal(sent.length, 2); assert.equal(sent[0].media[0].currentTime, .8);
  assert.equal(sent[1].media[0].currentTime, .1); assert.equal(sent[1].media[0].errorCode, 3);
  assert.equal(sent[1].media[0].slot, sent[0].media[0].slot); assert.equal(sent[1].trigger, 'error');
  assert.equal(sent[0].blockedFrames, 1); assert.ok(!JSON.stringify(sent).includes('secret'));
  probe.close(); probe.sample(); assert.equal(sent.length, 2);
  assert.equal(root.listeners.size, 0); assert.equal(frame.listeners.size, 0);
});
test('sonde : contrôleur indisponible et documents remplacés ne perturbent pas la lecture', async () => {
  const frames = [], frame = doc([]), root = doc([], frames);
  frames.push({ contentDocument: frame });
  const probe = createPlaybackDiagnostic(root, () => Promise.reject(new Error('offline')));
  assert.doesNotThrow(() => probe.sample()); frames.length = 0;
  probe.sample(); assert.equal(frame.listeners.size, 0); probe.close();
  await new Promise(resolve => setImmediate(resolve));
});

test('sonde : un lecteur actif placé après quatre médias en pause reste observé', () => {
  const idle = () => ({ currentTime: 0, paused: true, readyState: 4, networkState: 1 });
  const active = { ...idle(), paused: false, currentTime: 17 };
  const failed = { ...idle(), error: { code: 3 } };
  const sent = [], probe = createPlaybackDiagnostic(doc([...Array.from({ length: 8 }, idle), active, failed]), data => sent.push(data));
  probe.sample(); probe.close();
  assert.equal(sent[0].mediaCount, 10); assert.equal(sent[0].media.length, 4);
  assert.equal(sent[0].media[0].errorCode, 3);
  assert.ok(sent[0].media.some(m => m.currentTime === 17 && !m.paused));
});
