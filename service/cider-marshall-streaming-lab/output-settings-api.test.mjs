import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from './server.mjs';
const token = 'e'.repeat(64), old = 'old-endpoint', chosen = 'new-endpoint';
test('réglage API : authentification, sauvegarde confirmée, concurrence et restauration prioritaire', async () => {
  let pending = true, saves = 0, release, configSeen;
  class Transport {
    constructor() { this.stats = {}; this.queueMs = 0; }
    async open() { this.ready = true; }
    async close() { this.ready = false; }
  }
  const settings = { async list() { return []; }, async save(value) { saves++; await new Promise(resolve => release = resolve); return value; } };
  const service = createService({ token, endpointId: old }, {
    outputSettings: settings, recoveryPending: () => pending,
    Streaming: Transport, discover: async () => ({ host: '127.0.0.1', port: 8009 }),
    createAudioBridge(config) { configSeen = config.endpointId; return { ready: Promise.resolve(), setLocal() {}, resume() {}, async close() {} }; },
  });
  await new Promise(resolve => service.control.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + service.control.address().port;
  const req = (route, data) => fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Marshall-Token': token }, body: data === undefined ? undefined : JSON.stringify(data) });
  try {
    assert.equal((await fetch(base + '/audio-outputs')).status, 403);
    assert.equal((await (await req('/audio-outputs')).json()).locked, true);
    assert.equal((await req('/audio-output', { endpointId: chosen })).status, 409); assert.equal(saves, 0);
    pending = false;
    assert.equal((await req('/audio-output', { endpointId: chosen, token: 'bad' })).status, 400);
    const saving = req('/audio-output', { endpointId: chosen });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await req('/audio-output', { endpointId: old })).status, 409);
    assert.equal((await req('/start', { version: '1.0.0-rc.2' })).status, 409);
    release(); assert.deepEqual(await (await saving).json(), { saved: true });
    assert.equal(saves, 1);
    assert.equal((await req('/start', { version: '1.0.0-rc.2' })).status, 200);
    assert.equal(configSeen, chosen);
    pending = true;
    assert.equal((await (await req('/audio-outputs')).json()).pendingRecovery, false);
    assert.equal((await req('/audio-output', { endpointId: old })).status, 409);
    await req('/local', {});
    assert.equal((await req('/audio-output', { endpointId: old })).status, 409);
  } finally { await service.close(); await new Promise(resolve => service.control.close(resolve)); }
});
test('première installation : liste des sorties accessible, Cast refusé avant choix explicite', async () => {
  let attempts = 0;
  const service = createService({ token, endpointId: '' }, { recoveryPending: () => false, outputSettings: { async list(id) { assert.equal(id, ''); return []; } }, discover: async () => { attempts++; } });
  await new Promise(resolve => service.control.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + service.control.address().port, headers = { 'X-Marshall-Token': token };
  try {
    assert.equal((await (await fetch(base + '/status', { headers })).json()).setupRequired, true);
    assert.equal((await fetch(base + '/audio-outputs', { headers })).status, 200);
    assert.equal((await fetch(base + '/start', { method: 'POST', headers, body: JSON.stringify({ version: '1.0.0-rc.2' }) })).status, 409);
    assert.equal(attempts, 0);
  } finally { await service.close(); await new Promise(resolve => service.control.close(resolve)); }
});
