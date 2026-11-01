import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from './server.mjs';
import { Streaming, receiverVolume } from './streaming.mjs';

test('volume récepteur : validation, confirmation réelle, refus et absence de commande audio', async () => {
  const calls = [];
  const transport = Object.assign(Object.create(Streaming.prototype), {
    ready: true, volume: { level: .2, muted: false, adjustable: true },
    async request(destination, namespace, body) {
      calls.push(body);
      return { type: 'RECEIVER_STATUS', status: { volume: { level: .4, muted: false } } };
    },
  });
  assert.deepEqual(await transport.setVolume({ level: .4, muted: false }), { level: .4, muted: false, adjustable: true });
  for (const value of [{ level: -1 }, { level: 2 }, { level: NaN }, { muted: 'false' }, { host: '8.8.8.8' }, [], null, {}]) await assert.rejects(transport.setVolume(value), /invalide/);
  assert.equal(calls.length, 1); assert.equal(calls[0].type, 'SET_VOLUME');
  transport.request = async () => ({ type: 'INVALID_REQUEST' });
  await assert.rejects(transport.setVolume({ muted: true }), /confirmé/);
  assert.equal(transport.volume.level, .4);
  transport.volume.adjustable = false;
  await assert.rejects(transport.setVolume({ level: .1 }), /fixe/);
  assert.equal(receiverVolume({ level: Infinity, muted: false }), null);
  assert.equal(receiverVolume({ level: .5 }), null);
  assert.equal(receiverVolume({ level: .5, muted: false, controlType: 'fixed' }).adjustable, false);
});

test('API appareils : rafraîchissement, disparition, sélection par identité, volume et ancienne session', async () => {
  const token = 'f'.repeat(64); let announced = [{ id: 'cast:pair', name: 'Marshall', host: '127.0.0.1', port: 8009, group: true }];
  let selected, transport, hooks, local = true, scans = 0;
  class FakeTransport {
    constructor(device, callbacks) { selected = device; this.hooks = callbacks; transport = this; this.stats = {}; this.queueMs = 0; this.volume = { level: .2, muted: false, adjustable: true }; }
    async open() { this.ready = true; }
    write() {}
    async close() { this.ready = false; }
    async setVolume(value) { if (value.level > 1) throw Error('Volume invalide.'); this.volume = { ...this.volume, ...value }; return this.volume; }
  }
  const service = createService({ endpointId: 'test-only', token, target: 'Marshall' }, {
    Streaming: FakeTransport,
    async discoverDevices() { scans++; return announced; },
    async discover(id) { const found = announced.find(d => d.id === id); if (!found) throw Error('Appareil introuvable'); return found; },
    createAudioBridge(config, callbacks) { hooks = callbacks; return { ready: Promise.resolve(), get local() { return local; }, setLocal(value) { local = value; }, async close() {} }; },
  });
  await new Promise(resolve => service.control.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + service.control.address().port;
  const req = (url, data) => fetch(base + url, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Marshall-Token': token }, body: data === undefined ? undefined : JSON.stringify(data) });
  async function devicesRequest(url, data) {
    let result = await (await req(url, data)).json();
    while (result.discovering) result = await (await req('/devices')).json();
    return result;
  }
  try {
    assert.equal((await fetch(base + '/devices')).status, 403);
    const devices = await (await req('/devices')).json();
    assert.equal(devices.devices[0].id, 'cast:pair'); assert.equal(devices.devices[0].knownPair, true);
    assert.equal(devices.devices[0].host, undefined);
    await req('/devices'); assert.equal(scans, 1);
    assert.equal((await req('/start', { version: '1.0.0-rc.2', deviceId: 42 })).status, 400);
    const session = await (await req('/start', { version: '1.0.0-rc.2', deviceId: 'cast:pair' })).json();
    assert.equal(selected.id, 'cast:pair');
    hooks.audio(Buffer.alloc(8), .1); transport.hooks.stats({ feedback: 1, feedbackAgeMs: 1 }); assert.equal(local, false);
    assert.equal((await req('/shutdown', {})).status, 409);
    assert.equal((await req('/volume?id=old', { level: .3 })).status, 409);
    assert.equal((await req('/volume?id=' + session.id, { level: 2 })).status, 400);
    assert.equal((await (await req('/status')).json()).active, true);
    assert.equal((await (await req('/volume?id=' + session.id, { level: .3 })).json()).volume.level, .3);
    announced = [];
    const absent = await devicesRequest('/devices/refresh', {});
    assert.equal(scans, 2); assert.equal(absent.devices[0].available, false);
    assert.equal((await (await req('/status')).json()).deviceId, 'cast:pair');
    await req('/stop?id=' + session.id, {});
    assert.deepEqual((await devicesRequest('/devices/refresh', {})).devices, []);
    assert.equal((await req('/start', { version: '1.0.0-rc.2', deviceId: 'cast:pair' })).status, 400);
  } finally { await service.close(); service.control.closeAllConnections(); await new Promise(resolve => service.control.close(resolve)); }
});

test('API découverte : première annonce disponible avant la fin, sans perdre les appareils plus lents', async () => {
  let update, finish;
  const pair = { id: 'cast:pair', name: 'Marshall', host: '192.168.1.2', port: 8009 };
  const late = { ...pair, id: 'cast:late', name: 'Autre enceinte' };
  const service = createService({ endpointId: 'test-only', token: 'f'.repeat(64), target: 'Marshall' }, {
    discoverDevices(duration, createMdns, callback) {
      update = callback;
      return new Promise(resolve => finish = resolve);
    },
  });
  await new Promise(resolve => service.control.listen(0, '127.0.0.1', resolve));
  const req = async () => (await fetch('http://127.0.0.1:' + service.control.address().port + '/devices', { headers: { 'X-Marshall-Token': 'f'.repeat(64) } })).json();
  try {
    const first = req();
    while (!update) await new Promise(resolve => setImmediate(resolve));
    update([pair]);
    const early = await first;
    assert.equal(early.discovering, true);
    assert.deepEqual(early.devices.map(d => d.id), ['cast:pair']);
    update([pair, late]);
    assert.equal((await req()).devices.length, 2);
    finish([pair, late]);
    const done = await req();
    assert.equal(done.discovering, false);
    assert.equal(done.devices.length, 2);
  } finally { finish?.([]); await service.close(); service.control.closeAllConnections(); await new Promise(resolve => service.control.close(resolve)); }
});
