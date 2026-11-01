import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutputControl } from './output-control.js';
const pc = () => ({ version: '1.0.0-rc.2', active: false, phase: 'pc', output: 'direct', error: '' });

test('retour PC après perte de capture : commande explicite même sans identifiant, message de récupération visible', async () => {
  const calls = [];
  const status = { ...pc(), output: 'unavailable', phase: 'error', needsRestart: true, error: 'File audio supérieure à 500 ms.' };
  const control = createOutputControl(async route => {
    calls.push(route);
    if (route === '/local') throw new Error('Fermez puis rouvrez Cider pour rétablir la sortie PC.');
    return status;
  }, () => {});
  await control.refresh(); await control.select('pc');
  assert.ok(calls.includes('/local'));
  assert.match(control.state.error, /Fermez puis rouvrez Cider/);
  assert.equal(control.state.action, null);
});

test('reprend une session existante, revient au PC et conserve l’état à la réouverture', async () => {
  let status = { ...pc(), active: true, id: 'existing', phase: 'casting', output: 'cast' };
  const calls = [];
  const control = createOutputControl(async route => { calls.push(route); if (route.startsWith('/stop') || route === '/local') status = pc(); return { ...status }; }, () => {});
  await control.refresh(); assert.equal(control.state.status.output, 'cast');
  assert.ok(calls.includes('/heartbeat?id=existing'));
  await control.select('pc'); assert.equal(control.state.action, null); assert.equal(control.state.status.output, 'direct');
  await control.refresh(); assert.equal(control.state.online, true);
});

test('erreur HTTP temporaire : aucun arrêt envoyé, état resynchronisé au retour', async () => {
  let fail = true; const calls = [];
  const control = createOutputControl(async route => { calls.push(route); if (fail) throw new Error('network'); return pc(); }, () => {});
  await control.refresh(); assert.equal(control.state.online, false);
  fail = false; await control.refresh(); assert.equal(control.state.online, true);
  assert.equal(control.state.error, '');
  assert.ok(!calls.some(route => route.startsWith('/stop')));
});

test('annulation avant que start réponde : aucun Cast orphelin, boutons débloqués', async () => {
  let finish, status = pc();
  const control = createOutputControl(async route => {
    if (route === '/start') { await new Promise(resolve => finish = resolve); status = { ...pc(), active: true, id: 'new', output: 'cast' }; return { id: 'new' }; }
    if (route.startsWith('/stop') || route === '/local') status = pc();
    return { ...status };
  }, () => {});
  await control.refresh(); const start = control.select('cast'); const stop = control.select('pc');
  await new Promise(resolve => setImmediate(resolve)); finish();
  await Promise.all([start, stop]);
  assert.equal(control.state.action, null); assert.equal(control.state.status.active, false); assert.equal(status.output, 'direct');
});

test('échec de connexion et version incompatible : aucune sélection Cast fictive', async () => {
  const control = createOutputControl(async route => { if (route === '/start') throw new Error('Enceintes introuvables'); return pc(); }, () => {});
  await control.refresh(); await control.select('cast');
  assert.equal(control.state.action, null); assert.equal(control.state.status.output, 'direct'); assert.match(control.state.error, /introuvables/);
  const old = createOutputControl(async () => ({ ...pc(), version: 'old' }), () => {});
  await old.refresh(); assert.equal(old.state.online, false); assert.match(old.state.error, /mis à jour/);
});

test('liste indépendante : retrait réseau sans déconnexion, changement de cible et volume confirmé', async () => {
  let status = pc(), devices = [{ id: 'one', name: 'Même nom', available: true }, { id: 'two', name: 'Même nom', available: true }];
  const calls = [];
  const control = createOutputControl(async (route, body) => {
    calls.push({ route, body });
    if (route.startsWith('/devices')) return { devices };
    if (route === '/start') status = { ...pc(), active: true, id: body.deviceId, deviceId: body.deviceId, output: 'cast', volume: { level: .2, muted: false } };
    if (route.startsWith('/stop') || route === '/local') status = pc();
    if (route.startsWith('/volume')) return { volume: { level: body.level, muted: false } };
    return { ...status };
  }, () => {});
  await control.refresh(); await control.discover(); await control.select('one');
  assert.equal(control.state.status.deviceId, 'one');
  await control.setVolume({ level: .3 }); assert.equal(control.state.status.volume.level, .3);
  await control.select('two'); assert.equal(control.state.status.deviceId, 'two');
  assert.ok(calls.some(c => c.route === '/stop?id=one'));
  const stops = calls.filter(c => c.route.startsWith('/stop')).length;
  devices = []; await control.discover(true);
  assert.equal(control.state.status.active, true);
  assert.equal(calls.filter(c => c.route.startsWith('/stop')).length, stops);
});

test('volume : dernière valeur conservée en cas de gestes rapides, échec isolé sans stop', async () => {
  let release, count = 0;
  const calls = [];
  const control = createOutputControl(async (route, body) => {
    calls.push(route);
    if (route.startsWith('/volume')) {
      if (++count === 1) await new Promise(resolve => release = resolve);
      if (body.level === .9) throw new Error('Volume refusé');
      return { volume: { level: body.level, muted: false } };
    }
    return { ...pc(), active: true, id: 'session', volume: { level: .1, muted: false } };
  }, () => {});
  await control.refresh();
  const first = control.setVolume({ level: .2 });
  await control.setVolume({ level: .3 }); await control.setVolume({ level: .4 });
  release(); await first;
  assert.equal(count, 2); assert.equal(control.state.status.volume.level, .4);
  await control.setVolume({ level: .9 });
  assert.match(control.state.volumeError, /refusé/); assert.equal(control.state.status.active, true);
  assert.ok(!calls.some(c => c.startsWith('/stop')));
});

test('restauration au démarrage de Cider seulement : une tentative, jamais de changement à chaud après incident', async () => {
  let pending = true, fail = true, attempts = 0;
  const request = async route => {
    if (route === '/recover') { attempts++; if (fail) throw Error('not ready'); pending = false; }
    if (route.startsWith('/devices')) return { devices: [] };
    return { ...pc(), pendingRecovery: pending };
  };
  const control = createOutputControl(request, () => {});
  await control.refresh(); await control.refresh();
  assert.equal(attempts, 1); assert.equal(control.state.online, true); assert.match(control.state.error, /restauration/);
  fail = false; await control.retry(); assert.equal(attempts, 1);
  const reopened = createOutputControl(request, () => {});
  await reopened.refresh(); assert.equal(attempts, 2); assert.equal(reopened.state.status.pendingRecovery, false);
  pending = true; await reopened.refresh(); assert.equal(attempts, 2);
});

test('découverte progressive : appareil sélectionnable avant la fin et une seule recherche forcée', async () => {
  const calls = [], updates = [];
  let status = pc();
  const control = createOutputControl(async (route, body) => {
    calls.push(route);
    if (route.startsWith('/devices')) return { devices: [{ id: 'pair', available: true }, ...(calls.filter(r => r.startsWith('/devices')).length > 1 ? [{ id: 'late', available: true }] : [])], discovering: route === '/devices/refresh' };
    if (route === '/start') status = { ...pc(), active: true, id: 's', deviceId: body.deviceId, output: 'cast' };
    return status;
  }, state => updates.push({ busy: state.discoveryBusy, count: state.devices.length }));
  await control.refresh();
  const scan = control.discover(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(control.state.discoveryBusy, true);
  assert.equal(control.state.devices[0].id, 'pair');
  await control.select('pair');
  assert.equal(control.state.status.deviceId, 'pair');
  await scan;
  assert.equal(control.state.devices.length, 2);
  assert.equal(control.state.discoveryBusy, false);
  assert.equal(calls.filter(r => r === '/devices/refresh').length, 1);
  assert.ok(updates.some(s => s.busy && s.count === 1));
});

test('demarrage discret : grace bornee, puis erreur visible ; aucune grace apres connexion', async t => {
 let now=1000,fail=true; t.mock.method(Date,'now',()=>now);
 const control=createOutputControl(async()=>{if(fail)throw Error('network');return pc();},()=>{});
 await control.refresh();assert.equal(control.state.starting,true);assert.equal(control.state.error,'');
 now=8000;await control.refresh();assert.equal(control.state.starting,false);assert.equal(control.state.error,'network');
 fail=false;await control.refresh();assert.equal(control.state.online,true);
 fail=true;await control.refresh();assert.equal(control.state.starting,false);assert.equal(control.state.error,'network');
});
