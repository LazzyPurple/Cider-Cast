import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive, ref, watch, watchEffect, nextTick } from 'vue';
import { createNativeVolume } from './native-volume.js';

const ciderGain = value => value <= 0 ? 0 : Number((10 ** (33.22 * Math.log10(Math.round(value * 100) / 100) / 20)).toFixed(5));
const flush = async () => { await nextTick(); await Promise.resolve(); await nextTick(); };
function fixture(level = .3, gain = ciderGain(level), storage = new Map()) {
  const normalized = ref(level), source = ref(gain);
  const music = reactive({ normalizedVolume: normalized, volumeOnChange: ref(level) });
  const apple = reactive({ volume: source });
  const win = { CiderApp: { musicKitStore: music, config: { getValue: () => true } }, __PLUGINSYS__: { Stores: { appleMusicStore: apple } }, document: new EventTarget(),
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) } };
  // Same asynchronous normalized-volume watcher and persistence as Cider 4.0.29.
  const stop = watch(normalized, async value => { await Promise.resolve(); apple.volume = win.CiderApp.config.getValue() ? ciderGain(value) : value; win.localStorage.setItem('volume', String(value)); });
  const state = { online: true, volumeBusy: false, status: { active: false, output: 'direct' } }, commands = [];
  let native;
  const control = { state, async setVolume(value) {
    commands.push(value); state.volumeBusy = true; native.sync(state);
    await Promise.resolve();
    state.status.volume = { ...state.status.volume, ...value };
    state.volumeBusy = false; native.sync(state);
  } };
  native = createNativeVolume(win, control);
  function cast(volume = { level: .6, muted: false, adjustable: true }) { state.status = { active: true, id: 'cast', output: 'cast', volume }; native.sync(state); }
  function icon(value) {
    const event = new Event('click'); Object.defineProperty(event, 'target', { value: { closest: selector => selector === '.volume-icon-wrapper' ? {} : null } });
    win.document.dispatchEvent(event); music.normalizedVolume = value;
  }
  return { win, music, apple, state, commands, native, cast, icon, storage, normalized, source, close() { native.close(); stop(); } };
}

test('vrais refs Vue : curseur, réactivité et volume distant sans double atténuation ; retour PC préservé', async () => {
  const f = fixture(); let rendered;
  const stopRender = watchEffect(() => rendered = f.music.normalizedVolume);
  try {
    f.native.sync(f.state); assert.equal(f.music.normalizedVolume, .3);
    f.cast(); await flush();
    assert.equal(rendered, .6); assert.equal(f.apple.volume, 0.42806); assert.equal(f.commands.length, 0);
    f.music.normalizedVolume = .4; await flush();
    assert.deepEqual(f.commands, [{ level: .4, muted: false }]);
    assert.equal(rendered, .4); assert.equal(f.apple.volume, 0.42806);
    f.state.status.volume.level = .7; f.native.sync(f.state); await flush();
    assert.equal(rendered, .7); assert.equal(f.commands.length, 1); assert.equal(f.apple.volume, 0.42806);
    f.state.status = { active: false, output: 'pc' }; f.native.sync(f.state); await flush();
    assert.equal(rendered, .3); assert.equal(f.apple.volume, ciderGain(.3));
    f.music.normalizedVolume = .5; await flush();
    assert.equal(f.apple.volume, ciderGain(.5)); assert.equal(f.commands.length, 1);
    assert.equal(Object.hasOwn(f.normalized, 'value'), false);
    assert.equal(Object.hasOwn(f.source, 'value'), false);
  } finally { stopRender(); f.close(); }
});

test('icône native et sourdine externe : préserver le niveau du récepteur, y compris au rétablissement', async () => {
  const f = fixture();
  try {
    f.cast({ level: .7, muted: false, adjustable: true }); await flush();
    f.icon(0); await flush();
    assert.equal(f.music.normalizedVolume, 0); assert.equal(f.state.status.volume.level, .7);
    assert.deepEqual(f.commands[0], { muted: true });
    f.icon(.3); await flush();
    assert.equal(f.music.normalizedVolume, .7); assert.deepEqual(f.commands[1], { muted: false });
    f.state.status.volume.muted = true; f.native.sync(f.state); await flush();
    assert.equal(f.music.normalizedVolume, 0); assert.equal(f.commands.length, 2);
    f.icon(.3); await flush(); assert.equal(f.music.normalizedVolume, .7);
    f.music.normalizedVolume = 0; await flush();
    assert.deepEqual(f.commands.at(-1), { muted: true }); assert.equal(f.apple.volume, 0.42806);
    f.state.status.volume = { level: 0, muted: false, adjustable: true }; f.native.sync(f.state);
    f.icon(.3); await flush();
    assert.deepEqual(f.commands.at(-1), { muted: false, level: .3 });
    assert.equal(f.music.normalizedVolume, .3);
  } finally { f.close(); }
});

test('PC initialement muet : Cast devient audible sans appliquer deux gains et le retour PC reste muet', async () => {
  const f = fixture(0);
  try {
    f.cast({ level: .5, muted: false, adjustable: true }); await flush();
    assert.equal(f.apple.volume, .42806);
    f.music.normalizedVolume = .8; await flush();
    assert.equal(f.apple.volume, .42806);
    f.state.status = { active: false, output: 'direct' }; f.native.sync(f.state); await flush();
    assert.equal(f.music.normalizedVolume, 0); assert.equal(f.apple.volume, 0);
  } finally { f.close(); }
});

test('volume indisponible, fixe ou service hors ligne : aucune commande ni modification du signal', async () => {
  const f = fixture();
  try {
    f.cast({ level: .4, muted: false, adjustable: false }); await flush();
    f.music.normalizedVolume = .9; await flush();
    assert.equal(f.music.normalizedVolume, .4); assert.match(f.state.nativeVolumeError, /indisponible/);
    f.state.status.volume = null; f.native.sync(f.state);
    f.music.normalizedVolume = .8;
    f.state.online = false; f.music.normalizedVolume = .7; await flush();
    assert.equal(f.commands.length, 0); assert.equal(f.apple.volume, 0.42806);
  } finally { f.close(); }
});

test('fermeture et reprise après interruption : restaurer le volume PC sauvegardé', async () => {
  const f = fixture(); f.cast(); await flush();
  const second = fixture(.6, ciderGain(.6), f.storage);
  try {
    second.native.sync(second.state); await flush();
    assert.equal(second.music.normalizedVolume, .3); assert.equal(second.apple.volume, ciderGain(.3));
    assert.equal(second.storage.has('marshall-cast-pc-volume'), false);
    assert.equal(second.storage.get('volume'), '0.3');
  } finally { second.close(); f.close(); }
});

test('API hôte incompatible : erreur explicite et aucun crochet installé', () => {
  const f = fixture();
  try {
    f.win.__PLUGINSYS__.Stores.appleMusicStore = { volume: .1 };
    f.cast();
    assert.match(f.state.nativeVolumeError, /indisponible/);
    assert.equal(Object.hasOwn(f.normalized, 'value'), false);
    assert.equal(f.music.normalizedVolume, .3);
  } finally { f.close(); }
});

test('source native fixe à 60 % indépendamment du volume PC et du niveau des enceintes', async () => {
  for (const exponential of [true, false]) for (const pc of [.1, .9]) {
    const f = fixture(pc);
    try {
      f.win.CiderApp.config.getValue = () => exponential;
      f.cast({ level: .2, muted: false, adjustable: true }); await flush();
      assert.equal(f.apple.volume, exponential ? .42806 : .6);
      f.music.normalizedVolume = .8; await flush();
      assert.equal(f.apple.volume, exponential ? .42806 : .6);
      f.state.status = { active: false, output: 'pc' }; f.native.sync(f.state); await flush();
      assert.equal(f.music.normalizedVolume, pc);
      assert.equal(f.apple.volume, exponential ? ciderGain(pc) : pc);
    } finally { f.close(); }
  }
});
