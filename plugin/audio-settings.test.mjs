import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioSettings } from './audio-settings.js';
test('réglages : chargement à la demande, verrouillage et sélection confirmée seulement', async () => {
  let locked = true, fail = false, saves = 0;
  const settings = createAudioSettings(async (route, data) => {
    if (route === '/audio-outputs') return { outputs: [{ id: 'old', selected: true }, { id: 'new', selected: false }], locked, pendingRecovery: locked };
    saves++; assert.equal(data.endpointId, 'new'); if (fail) throw Error('Refus de la sortie'); return { saved: true };
  }, () => {});
  await settings.refresh(); await settings.select('new'); assert.equal(saves, 0);
  locked = false; await settings.refresh(); fail = true; await settings.select('new');
  assert.match(settings.state.error, /Refus/); assert.equal(settings.state.outputs[0].selected, true);
  fail = false; await settings.select('new'); assert.equal(settings.state.saved, true); assert.equal(settings.state.outputs[1].selected, true);
  assert.equal(settings.state.outputs[0].selected, false); assert.equal(settings.state.busy, false);
});
