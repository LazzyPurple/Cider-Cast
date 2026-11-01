import test, { beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { discover, discoverDevices } from './discover.mjs';
import os from 'node:os';

beforeEach(() => mock.method(os, 'networkInterfaces', () => ({ WiFi: [{ family: 'IPv4', internal: false, address: '192.168.31.77' }] })));
afterEach(() => mock.restoreAll());

function peer(host = '192.168.31.25') {
  const dns = new EventEmitter(); dns.destroyed = false;
  dns.destroy = () => { dns.destroyed = true; };
  dns.query = () => dns.emit('response', { answers: [
    { name: 'pair._googlecast._tcp.local', type: 'TXT', data: [Buffer.from('fn=Marshall')] },
    { name: 'pair._googlecast._tcp.local', type: 'SRV', data: { target: 'speaker.local', port: 8009 } },
    { name: 'speaker.local', type: 'A', data: host },
  ] });
  return dns;
}

test('découverte : ne lie jamais une ancienne adresse DHCP et recrée la recherche à chaque tentative', async () => {
  const calls = [];
  for (const oldAddress of ['192.168.31.140', '192.168.31.102']) {
    const dns = peer();
    const device = await discover('Marshall', oldAddress, 5, (...args) => { calls.push(args); return dns; });
    assert.equal(device.host, '192.168.31.25'); assert.equal(dns.destroyed, true);
  }
  assert.deepEqual(calls, [[{ interface: '192.168.31.77', bind: '0.0.0.0' }], [{ interface: '192.168.31.77', bind: '0.0.0.0' }]]);
});

test('interfaces : interroger Wi-Fi et réseau virtuel, conserver les annonces malgré une interface en erreur', async () => {
  os.networkInterfaces.mock.mockImplementation(() => ({
    WSL: [{ family: 'IPv4', internal: false, address: '172.20.0.1' }],
    WiFi: [{ family: 'IPv4', internal: false, address: '192.168.31.77' }],
    loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  }));
  const clients = [], calls = [];
  const list = await discoverDevices(5, options => {
    calls.push(options);
    const dns = peer(); clients.push(dns);
    if (options.interface.startsWith('172.')) dns.query = () => dns.emit('error', new Error('interface unavailable'));
    return dns;
  });
  assert.equal(list.length, 1); assert.equal(clients.length, 2); assert.ok(clients.every(d => d.destroyed));
  assert.deepEqual(calls.map(x => x.interface), ['172.20.0.1', '192.168.31.77']);
  assert.ok(calls.every(x => x.bind === '0.0.0.0'));
});

test('interfaces : aucune interface utilisable ne crée de socket ; une création échouée libère les précédentes', async () => {
  os.networkInterfaces.mock.mockImplementation(() => ({}));
  assert.deepEqual(await discoverDevices(5, () => assert.fail('offline socket')), []);
  os.networkInterfaces.mock.mockImplementation(() => ({ A: [{ family: 'IPv4', internal: false, address: '192.168.1.1' }, { family: 'IPv4', internal: false, address: '192.168.1.2' }] }));
  const dns = peer(); let calls = 0;
  await assert.rejects(discoverDevices(5, () => { if (calls++) throw new Error('creation failed'); return dns; }), /creation failed/);
  assert.equal(dns.destroyed, true);
});

test('changement de Wi-Fi : nouvelle interface et nouvelle adresse relues à la recherche suivante', async () => {
  const calls = [];
  for (const [interfaceName, local, speaker] of [['WiFi', '192.168.31.77', '192.168.31.25'], ['Ethernet', '10.0.0.42', '10.0.0.20']]) {
    os.networkInterfaces.mock.mockImplementation(() => ({ [interfaceName]: [{ family: 'IPv4', internal: false, address: local }] }));
    const list = await discoverDevices(5, options => { calls.push(options.interface); return peer(speaker); });
    assert.equal(list[0].host, speaker);
  }
  assert.deepEqual(calls, ['192.168.31.77', '10.0.0.42']);
});

test('erreur dès la première requête : message lisible et socket libérée', async () => {
  const dns = peer(); dns.query = () => dns.emit('error', new Error('bind EADDRNOTAVAIL 192.168.31.140:5353'));
  await assert.rejects(discover('Marshall', 'old', 1000, () => dns), error => /Wi-Fi/.test(error.message) && !error.message.includes('bind'));
  assert.equal(dns.destroyed, true);
});

test('découverte : ignore une adresse annoncée invalide ou extérieure au réseau local', async () => {
  for (const host of ['192.168.evil.invalid', '8.8.8.8']) {
    const dns = peer(host);
    await assert.rejects(discover('Marshall', 'old', 5, () => dns), /introuvable/);
    assert.equal(dns.destroyed, true);
  }
});

test('liste Cast : identité stable, noms identiques, groupe, annonces incomplètes et retrait TTL zéro', async () => {
  const dns = peer();
  dns.query = () => dns.emit('response', { answers: [
    ...['one', 'two', 'group', 'gone', 'incomplete'].flatMap(id => [
      { name: `${id}._googlecast._tcp.local`, type: 'TXT', data: [Buffer.from('id=' + id), Buffer.from('fn=Salon'), Buffer.from('md=' + (id === 'group' ? 'Google Cast Group' : 'Speaker'))] },
      ...(id === 'incomplete' ? [] : [{ name: `${id}._googlecast._tcp.local`, type: 'SRV', data: { target: 'SPEAKER.local', port: 8009 } }]),
    ]),
    { name: 'speaker.local', type: 'A', data: '192.168.31.25' },
    { name: 'gone._googlecast._tcp.local', type: 'TXT', ttl: 0 },
  ] });
  const list = await discoverDevices(5, () => dns);
  assert.deepEqual(list.map(d => d.id).sort(), ['cast:group', 'cast:one', 'cast:two']);
  assert.equal(list.find(d => d.id === 'cast:group').group, true);
  assert.ok(list.every(d => d.host === '192.168.31.25'));
  await assert.rejects(discover('Salon', '', 5, () => dns), /ambigu/);
  assert.equal((await discover('cast:two', '', 5, () => dns)).id, 'cast:two');
});

test('annonces progressives : publier le premier appareil complet et continuer la collecte', async () => {
  const dns = peer(), seen = [];
  let complete = false;
  const scan = discoverDevices(20, () => dns, devices => seen.push(devices)).then(devices => { complete = true; return devices; });
  assert.equal(seen[0][0].name, 'Marshall');
  assert.equal(complete, false);
  dns.emit('response', { answers: [
    { name: 'late._googlecast._tcp.local', type: 'TXT', data: [Buffer.from('fn=Autre enceinte')] },
    { name: 'late._googlecast._tcp.local', type: 'SRV', data: { target: 'speaker.local', port: 8009 } },
  ] });
  assert.equal(seen.at(-1).length, 2);
  assert.equal((await scan).length, 2);
  assert.equal(dns.destroyed, true);
});

test('annonces réseau abondantes : nombre de fiches borné et TTL invalides ignorés', async () => {
 const dns = peer(); dns.query = () => dns.emit('response', { answers: [
 {name:'speaker.local',type:'A',data:'192.168.31.25'},
 ...Array.from({length:1500},(_,i)=>[{name:i+'._googlecast._tcp.local',type:'TXT',data:[Buffer.from('id=x'+i),Buffer.from('fn=Enceinte '+i)]},{name:i+'._googlecast._tcp.local',type:'SRV',data:{target:'speaker.local',port:8009}}]).flat(),
 ] });
 const list=await discoverDevices(5,()=>dns); assert.ok(list.length>0 && list.length<=512); assert.equal(dns.destroyed,true);
 const invalid=peer(); invalid.query=()=>invalid.emit('response',{answers:[{name:'invalid._googlecast._tcp.local',type:'TXT',ttl:NaN,data:[Buffer.from('fn=Invalid')]}]});
 assert.deepEqual(await discoverDevices(5,()=>invalid),[]);
});
