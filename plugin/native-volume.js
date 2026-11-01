const pcVolumeKey = 'marshall-cast-pc-volume';
const valid = value => Number.isFinite(value) && value >= 0 && value <= 1;

function volumeRef(store, key) {
  const ref = Object.getOwnPropertyDescriptor(store, key)?.value;
  const own = ref && Object.getOwnPropertyDescriptor(ref, 'value');
  const access = own ?? (ref && Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ref), 'value'));
  if (!ref?.__v_isRef || !access?.get || !access?.set || own?.configurable === false || !Object.isExtensible(ref) || !valid(ref.value)) throw Error('Volume natif incompatible.');
  return { ref, own, access, read: () => access.get.call(ref), write: value => access.set.call(ref, value) };
}

// Cider 4.0.29: AMVolumeSlider binds musickit.normalizedVolume; its watcher writes appleMusic.volume.
// Fix the source at native 60%; its 4.0.29 exponential curve is separate from receiver volume.
export function createNativeVolume(win, control) {
  let ui, source, store, saved, sessionId, toggle = false, closed = false;
  function journal() {
    const value = JSON.parse(win.localStorage.getItem(pcVolumeKey) || 'null');
    return value && valid(value.level) && valid(value.gain) ? value : null;
  }
  function host() {
    store = win.CiderApp?.musicKitStore;
    ui = volumeRef(store, 'normalizedVolume');
    source = volumeRef(win.__PLUGINSYS__?.Stores?.appleMusicStore, 'volume');
  }
  function display(value) { if (valid(value) && Math.abs(ui.read() - value) > .0001) ui.write(value); }
  function restore() {
    sessionId = null;
    if (ui) {
      for (const slot of [ui, source]) {
        if (slot.own) Object.defineProperty(slot.ref, 'value', slot.own);
        else delete slot.ref.value;
      }
      display(saved.level); source.write(saved.gain);
      if (valid(saved.released)) store.volumeOnChange = saved.released;
      win.localStorage.setItem('volume', String(saved.level));
      win.localStorage.removeItem(pcVolumeKey);
      ui = source = saved = null;
    }
  }
  function gesture(value) {
    const state = control.state, volume = state.status?.volume;
    if (!valid(value)) return;
    if (!state.online || !valid(volume?.level) || typeof volume.muted !== 'boolean' || volume.adjustable === false) {
      state.nativeVolumeError = 'Volume des enceintes indisponible pour le moment.';
      return;
    }
    state.nativeVolumeError = '';
    const command = toggle ? { muted: !(volume.muted || volume.level === 0) } : value === 0 ? { muted: true } : { level: value, muted: false };
    if (toggle && !command.muted && volume.level === 0 && value > 0) command.level = value;
    display(toggle ? command.muted ? 0 : command.level ?? volume.level : value);
    void control.setVolume(command);
  }
  function onClick(event) {
    if (!sessionId || !event.target?.closest?.('.volume-icon-wrapper')) return;
    toggle = true;
    queueMicrotask(() => toggle = false);
  }
  win.document.addEventListener('click', onClick, true);
  function sync(state) {
    if (closed || !state.online) return;
    try {
      const status = state.status;
      if (!status?.active) {
        if (!ui) {
          saved = journal();
          if (saved) host();
        }
        restore(); state.nativeVolumeError = ''; return;
      }
      if (!ui) {
        host();
        const exponential = win.CiderApp.config?.getValue?.('audio.exponentialVolume');
        if (typeof exponential !== 'boolean') throw Error('Courbe de volume indisponible.');
        const castGain = exponential ? Number((10 ** (33.22 * Math.log10(.6) / 20)).toFixed(5)) : .6;
        saved = journal() ?? { level: ui.read(), gain: source.read(), released: Number(store.volumeOnChange) };
        win.localStorage.setItem(pcVolumeKey, JSON.stringify(saved));
        Object.defineProperty(source.ref, 'value', { configurable: true,
          get: source.read,
          set() {},
        });
        Object.defineProperty(ui.ref, 'value', { configurable: true, get: ui.read, set: gesture });
        source.write(castGain);
      }
      sessionId = status.id;
      if (!state.volumeBusy && valid(status.volume?.level)) display(status.volume.muted ? 0 : status.volume.level);
    } catch {
      if (ui && saved) { try { restore(); } catch {} }
      ui = source = saved = null; sessionId = null;
      state.nativeVolumeError = 'La synchronisation du volume natif est indisponible sur cette version de Cider.';
    }
  }
  return { sync, close() { closed = true; win.document.removeEventListener('click', onClick, true); if (ui && saved) restore(); } };
}
