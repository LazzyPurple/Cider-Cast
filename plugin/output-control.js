export const VERSION = '1.0.0-rc.2';

export function createOutputControl(request, changed) {
  const state = { status: null, online: false, starting: true, action: null, error: '', devices: [], discoveryBusy: false, discoveryError: '', volumeBusy: false, volumeError: '' };
  const startupDeadline = Date.now() + 6000;
  let generation = 0, refreshPromise, discoveryPromise, pendingStart, networkError = false, recoveryAttempted = false, pendingVolume;
  function apply(status) {
    state.starting = false;
    if (status.version !== VERSION) throw new Error('Le contrôleur doit être mis à jour avant de choisir une sortie.');
    state.status = status; state.online = true;
  }
  async function refresh() {
    if (refreshPromise) return refreshPromise;
    const revision = generation;
    refreshPromise = (async () => {
      try {
        let status = await request('/status');
        if (revision !== generation) return;
        apply(status);
        if (networkError) { state.error = ''; networkError = false; }
        const bootRecovery = !recoveryAttempted; recoveryAttempted = true;
        if (status.pendingRecovery && !status.active && !state.action && bootRecovery) {
          try { await request('/recover', {}); status = await request('/status'); if (revision === generation) apply(status); }
          catch { state.error = 'La sortie PC attend sa restauration. Fermez puis rouvrez Cider.'; }
        }
        if (status.active && status.id) await request('/heartbeat?id=' + status.id, {});
      } catch (error) {
        if (revision === generation) { state.online = false; state.starting &&= Date.now() < startupDeadline; state.error = state.starting ? '' : error.message; networkError = true; }
      } finally { refreshPromise = null; changed(state); }
    })();
    return refreshPromise;
  }
  async function discover(force = false) {
    if (discoveryPromise) return discoveryPromise;
    state.discoveryBusy = true; state.discoveryError = ''; changed(state);
    discoveryPromise = (async () => {
      try {
        let result, first = true;
        do {
          result = await request(first && force ? '/devices/refresh' : '/devices', first && force ? {} : undefined);
          first = false;
          if (result.error) throw new Error(result.error);
          if (!Array.isArray(result.devices)) throw new Error('Liste des appareils indisponible.');
          state.devices = result.devices; changed(state);
          if (result.discovering) await new Promise(resolve => setTimeout(resolve, 250));
        } while (result.discovering);
      } catch (error) {
        state.discoveryError = error.message;
        state.devices = state.devices.map(d => ({ ...d, available: false }));
      } finally { state.discoveryBusy = false; discoveryPromise = null; changed(state); }
    })();
    return discoveryPromise;
  }
  async function select(device) {
    const selected = state.devices.find(d => d.id === device);
    if (!['pc', 'cast'].includes(device) && (!selected || !selected.available)) return;
    if ((device !== 'pc' && (state.action || (state.status?.active && (device === 'cast' || state.status.deviceId === device)))) || state.action === 'pc') return;
    const revision = ++generation;
    state.action = device === 'pc' ? 'pc' : 'cast'; state.actionDevice = device; state.error = ''; state.volumeError = ''; networkError = false; changed(state);
    try {
      if (device !== 'pc') {
        if (state.status?.active && state.status.id) await request('/stop?id=' + state.status.id, {});
        if (revision !== generation) return;
        pendingStart = request('/start', { version: VERSION, ...(selected ? { deviceId: selected.id } : {}) });
        try { await pendingStart; } finally { pendingStart = null; }
      } else {
        await request('/local', {});
        if (pendingStart) { await pendingStart.catch(() => {}); await request('/local', {}); }
      }
      if (revision === generation) apply(await request('/status'));
    } catch (error) {
      if (revision === generation) {
        state.error = error.message;
        try { apply(await request('/status')); } catch { state.online = false; }
      }
    } finally {
      if (revision === generation) { state.action = null; state.actionDevice = null; changed(state); }
    }
  }
  async function setVolume(value) {
    const id = state.status?.id;
    if (!id || !state.status.active) return;
    pendingVolume = { id, value };
    if (state.volumeBusy) return;
    state.volumeBusy = true; state.volumeError = ''; changed(state);
    try {
      while (pendingVolume) {
        const next = pendingVolume; pendingVolume = null;
        if (next.id !== state.status?.id) continue;
        try {
          const result = await request('/volume?id=' + next.id, next.value);
          if (next.id === state.status?.id) { state.status = { ...state.status, volume: result.volume }; state.volumeError = ''; }
        } catch (error) { if (next.id === state.status?.id) state.volumeError = error.message; }
      }
    } finally { state.volumeBusy = false; changed(state); }
  }
  async function retry() { state.error = ''; await refresh(); if (state.online) await discover(true); }
  return { state, refresh, discover, select, setVolume, retry };
}
