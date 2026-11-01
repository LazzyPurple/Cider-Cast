export function createAudioSettings(request, changed) {
  const state = { outputs: [], busy: false, locked: false, pendingRecovery: false, error: '', saved: false };
  async function refresh() {
    if (state.busy) return;
    state.busy = true; state.error = ''; changed(state);
    try {
      const result = await request('/audio-outputs');
      state.outputs = result.outputs; state.locked = result.locked; state.pendingRecovery = result.pendingRecovery;
    } catch (error) { state.error = error.message; }
    finally { state.busy = false; changed(state); }
  }
  async function select(id) {
    if (state.busy || state.locked) return;
    state.busy = true; state.error = ''; state.saved = false; changed(state);
    try {
      await request('/audio-output', { endpointId: id });
      state.outputs = state.outputs.map(output => ({ ...output, selected: output.id === id })); state.saved = true;
    } catch (error) { state.error = error.message; }
    finally { state.busy = false; changed(state); }
  }
  return { state, refresh, select };
}
