import { getConnection } from './connection.js';
import { release } from './release-info.js';
import { createOutputControl, VERSION } from './output-control.js';
import { createPlaybackDiagnostic } from './playback-diagnostic.js';
import { createNativeVolume } from './native-volume.js';
import { createAudioSettings } from './audio-settings.js';

const panels = new Set();
const settingsPanels = new Set();
const audioSettings = createAudioSettings(request, () => { for (const panel of settingsPanels) panel.render(); });
let chromeButton, timer, nativeVolume;
const speakerPath = 'M192,24H64A16,16,0,0,0,48,40V216a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V40A16,16,0,0,0,192,24Zm0,192H64V40H192ZM116,76a12,12,0,1,1,12,12A12,12,0,0,1,116,76Zm12,116a40,40,0,1,0-40-40A40,40,0,0,0,128,192Zm0-64a24,24,0,1,1-24,24A24,24,0,0,1,128,128Z';
const speaker = `<svg viewBox="0 0 256 256" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="${speakerPath}"/></svg>`;
const pc = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/></svg>';
const gear = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 2 2h3l1-3 3-1 2-3-2-2 1-3-2-3-3 1-2-2Z"/><circle cx="11.5" cy="11" r="3"/></svg>';
async function request(route, data) {
  const discovery = route === '/devices' || route === '/devices/refresh';
  try {
    const token = await getConnection().getToken();
    const response = await fetch('http://127.0.0.1:27275' + route, {
      method: data === undefined ? 'GET' : 'POST', headers: { 'X-Marshall-Token': token, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
      // Discovery itself listens for four seconds; allow time for its response too.
      signal: AbortSignal.timeout(route.startsWith('/start') ? 45000 : route.startsWith('/stop') ? 15000 : route === '/recover' ? 12000 : discovery ? 10000 : route.startsWith('/audio-output') ? 6000 : 4000),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 403) getConnection().reset();
      throw new Error(response.status === 403 ? 'La connexion au service a changé. Actualisez la connexion ou réinstallez le service Windows.' : result.error || 'La commande n’a pas abouti. Réessayez.');
    }
    return result;
  } catch (error) {
    if (discovery && error.name === 'TimeoutError') throw new Error('La recherche des appareils a pris trop de temps. Réessayez avec Actualiser.');
    if (error.name === 'TypeError') throw new Error('Le service Windows ne répond pas. Actualisez la connexion ou rouvrez Cider.');
    if (error.name === 'SyntaxError') throw new Error('Réponse du service Windows invalide. Réinstallez le service depuis le lien ci-dessous.');
    throw error;
  }
}
const control = createOutputControl(request, state => {
  nativeVolume?.sync(state);
  for (const panel of panels) panel.render();
  if (chromeButton) {
    const active = control.state.online && (control.state.status?.output === 'cast' || control.state.status?.phase === 'waiting');
    chromeButton.style.color = active ? 'var(--primary, var(--q-primary, currentColor))' : '';
    chromeButton.setAttribute('aria-label', active ? 'Sortie audio : ' + control.state.status.name : 'Choisir la sortie audio');
    chromeButton.title = active ? 'Lecture sur ' + control.state.status.name : 'Choisir la sortie audio';
  }
});
function installSpeakerIcon() {
  const draw = () => {
    for (const button of document.querySelectorAll('.chrome-button')) {
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) if (text.textContent === 'Cider Cast') {
        const icon = document.createElement('span'); icon.innerHTML = speaker; icon.style.display = 'flex';
        text.replaceWith(icon); chromeButton = button;
        button.setAttribute('aria-label', 'Choisir la sortie audio'); return true;
      }
    }
    return false;
  };
  const observer = new MutationObserver(() => { if (draw()) observer.disconnect(); });
  if (!draw()) observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
}
class OutputPanel extends HTMLElement {
  connectedCallback() {
    this.showingSettings = false;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;width:min(360px,calc(100vw - 48px));font:inherit;color:inherit}
      section{padding:20px}h2{font-size:18px;line-height:1.4;margin:0 0 16px;font-weight:650}
      .outputs{display:grid;gap:8px}button{font:inherit;color:inherit;cursor:pointer}
      .output{display:flex;align-items:center;gap:14px;width:100%;min-height:76px;padding:14px;border:1px solid transparent;border-radius:10px;text-align:left;background:color-mix(in srgb,currentColor 5%,transparent)}
      .output:hover:not(:disabled){background:color-mix(in srgb,currentColor 10%,transparent)}
      .output[aria-pressed="true"]{color:var(--primary, var(--q-primary, currentColor));background:color-mix(in srgb,var(--primary, var(--q-primary, currentColor)) 12%,transparent);border-color:color-mix(in srgb,var(--primary, var(--q-primary, currentColor)) 25%,transparent)}
      button:focus-visible{outline:2px solid var(--primary, var(--q-primary, currentColor));outline-offset:3px}.output:disabled{cursor:default}.output:disabled:not([aria-pressed="true"]){opacity:.55}
      .copy{display:grid;gap:3px;flex:1;min-width:0}.name{font-size:14px;font-weight:600;overflow-wrap:anywhere}.detail{font-size:12px;opacity:.7}
      .check{font-size:17px}.notice{font-size:12px;line-height:1.5;margin:14px 0 0;overflow-wrap:anywhere}
      .retry{background:none;border:0;padding:8px 0 0;text-decoration:underline;font-size:12px}[hidden]{display:none!important}
      .hint{font-size:11px;line-height:1.5;opacity:.55;margin:14px 0 0}.install{padding:12px;border-radius:8px;background:color-mix(in srgb,currentColor 6%,transparent);margin-top:12px;font-size:12px;line-height:1.5}.install p{margin:0 0 8px}.install a{display:inline-block;color:var(--primary,var(--q-primary,currentColor));font-weight:600;padding:4px 0}
      section{max-height:calc(100vh - 80px);overflow:auto}.devices{display:grid;gap:8px;max-height:240px;overflow:auto}section,.devices{scrollbar-width:thin;scrollbar-color:#666 transparent}
      .heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.refresh{border:0;background:none;padding:6px 0;font-size:12px;text-decoration:underline}
      .title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.title h2{margin:0}.settings{display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:8px;background:none;opacity:.7}.settings:hover{background:color-mix(in srgb,currentColor 8%,transparent);opacity:1}
    </style><section aria-labelledby="heading"><div class="title"><h2 id="heading">Sortie audio</h2><button type="button" class="settings" data-settings aria-label="Réglages de Cider Cast" title="Réglages de Cider Cast" aria-expanded="false">${gear}</button></div><div data-main>
      <div class="outputs" role="group" aria-label="Choisir où écouter Cider">
        <button type="button" class="output" data-pc>${pc}<span class="copy"><span class="name">Cet ordinateur</span><span class="detail" data-pc-detail>Lecture ici</span></span><span class="check" data-pc-check aria-hidden="true">✓</span></button>
        <div class="heading"><span class="detail">Appareils Google Cast</span><button type="button" class="refresh" data-refresh>Actualiser</button></div>
        <div class="devices" data-devices></div><p class="detail" data-empty role="status"></p>
        <p class="notice" data-discovery-error role="status"></p>
      </div><p class="notice" data-notice role="status" aria-live="polite"></p>
      <button type="button" class="retry" data-retry>Actualiser la connexion</button>
      <div class="install" data-install hidden><p>Le service Windows relie Cider à vos enceintes. Installez-le une seule fois, puis choisissez une sortie Windows inutilisée avec la roue dentée.</p><a data-installer target="_blank" rel="noopener noreferrer">Installer le service Windows</a><p>Fermez Cider, ouvrez l’installateur téléchargé, puis rouvrez Cider. Aucune clé à copier.</p><p data-download-unavailable hidden>Le téléchargement du service sera activé après publication de cette version.</p></div>
      <p class="hint">Les autres applications restent sur cet ordinateur.</p>
    </div><div data-settings-view id="settings-view" hidden></div></section>`;
    this.signature = '';
    this.shadowRoot.querySelector('[data-pc]').onclick = () => control.select('pc');
    this.shadowRoot.querySelector('[data-refresh]').onclick = () => control.discover(true);
    this.shadowRoot.querySelector('[data-retry]').onclick = () => control.retry();
    const installer = this.shadowRoot.querySelector('[data-installer]');
    if (release.installerUrl) installer.href = release.installerUrl;
    installer.hidden = !release.installerUrl;
    this.shadowRoot.querySelector('[data-download-unavailable]').hidden = !!release.installerUrl;
    this.shadowRoot.querySelector('[data-settings]').onclick = () => {
      this.showingSettings = !this.showingSettings;
      const button = this.shadowRoot.querySelector('[data-settings]'), view = this.shadowRoot.querySelector('[data-settings-view]');
      this.shadowRoot.querySelector('[data-main]').hidden = this.showingSettings; view.hidden = !this.showingSettings;
      this.shadowRoot.querySelector('h2').textContent = this.showingSettings ? 'Réglages' : 'Sortie audio';
      button.setAttribute('aria-expanded', String(this.showingSettings)); button.setAttribute('aria-label', this.showingSettings ? 'Retour à la sortie audio' : 'Réglages de Cider Cast'); button.title = button.getAttribute('aria-label');
      button.setAttribute('aria-controls', 'settings-view');
      button.innerHTML = this.showingSettings ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>' : gear;
      if (this.showingSettings) { const settings = document.createElement('marshall-isolated-settings'); settings.setAttribute('embedded', ''); view.replaceChildren(settings); }
      else { view.replaceChildren(); void control.refresh(); }
    };
    panels.add(this); this.render(); void control.refresh(); void control.discover();
  }
  disconnectedCallback() { panels.delete(this); }
  render() {
    const { status: s, online, action, error, devices, discoveryBusy, discoveryError, volumeError } = control.state;
    const q = selector => this.shadowRoot.querySelector(selector);
    const waiting = s?.phase === 'waiting';
    const local = online && !waiting && ['direct', 'pc'].includes(s?.output);
    const returning = action === 'pc' || s?.phase === 'returning';
    q('[data-pc]').setAttribute('aria-pressed', String(local));
    q('[data-pc-check]').hidden = !local;
    q('[data-pc]').disabled = returning || (!online && action !== 'cast') || (!s?.active && !action && local);
    q('[data-pc-detail]').textContent = returning ? 'Retour en cours…' : local ? 'Lecture ici' : s?.needsRestart || s?.pendingRecovery ? 'Rétablir la lecture PC' : 'Revenir sur cet ordinateur';
    const list = [...devices];
    if (s?.active && s.deviceId && !list.some(d => d.id === s.deviceId)) list.unshift({ id: s.deviceId, name: s.name, available: false });
    const signature = JSON.stringify(list);
    if (signature !== this.signature) {
      this.signature = signature;
      q('[data-devices]').replaceChildren(...list.map(device => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'output'; button.dataset.deviceId = device.id;
        button.innerHTML = `${speaker}<span class="copy"><span class="name"></span><span class="detail"></span></span><span class="check" aria-hidden="true">✓</span>`;
        button.querySelector('.name').textContent = device.name;
        button.onclick = () => control.select(device.id);
        return button;
      }));
    }
    for (const button of q('[data-devices]').children) {
      const device = list.find(d => d.id === button.dataset.deviceId);
      const selected = !!s?.active && s.deviceId === device.id;
      button.setAttribute('aria-pressed', String(selected)); button.querySelector('.check').hidden = !selected;
      button.disabled = !online || !!action || !device.available || !!s?.setupRequired || !!s?.needsRestart || !!s?.pendingRecovery || s?.phase === 'recovering' || selected;
      button.querySelector('.detail').textContent = action === 'cast' && control.state.actionDevice === device.id ? 'Connexion en cours…'
        : selected ? waiting ? 'Connecté · en attente de lecture' : 'Connecté · Google Cast'
        : !device.available ? 'Indisponible sur le réseau' : device.knownPair ? device.group ? 'Groupe Google Cast' : 'Google Cast' : 'Google Cast · compatibilité à vérifier';
    }
    q('[data-refresh]').disabled = discoveryBusy || !online;
    q('[data-refresh]').textContent = discoveryBusy ? 'Recherche…' : 'Actualiser';
    q('[data-empty]').textContent = !list.length ? discoveryBusy ? 'Recherche des appareils…' : 'Aucun appareil trouvé sur ce réseau.' : '';
    q('[data-empty]').hidden = !online || !!list.length || !!discoveryError;
    q('[data-discovery-error]').textContent = online ? discoveryError : ''; q('[data-discovery-error]').hidden = !online || !discoveryError;
    const notice = !online ? control.state.starting ? 'Connexion au service audio…' : error || 'Le service audio ne répond pas. Actualisez la connexion ou installez le service Windows.' : error || s?.error || (s?.setupRequired ? 'Pour commencer, choisissez une sortie Chromecast avec la roue dentée.' : '') || control.state.nativeVolumeError || volumeError || s?.volumeError || '';
    q('[data-notice]').textContent = notice; q('[data-notice]').hidden = !notice;
    q('[data-retry]').hidden = online || control.state.starting;
    q('[data-retry]').textContent = 'Actualiser la connexion';
    q('[data-install]').hidden = online || control.state.starting;
  }
}
class AudioSettingsPanel extends HTMLElement {
  connectedCallback() {
    this.signature = '';
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;font:inherit;color:inherit;padding:20px;max-width:640px}:host([embedded]){padding:0}h2{font-size:18px;margin:0 0 12px}p{font-size:13px;line-height:1.6}
      label{display:block;margin:20px 0 8px}select,button{font:inherit;color:inherit;background:color-mix(in srgb,currentColor 8%,transparent);border:1px solid #777;border-radius:6px;padding:10px}select{width:100%;max-width:100%}option{background:#242424;color:#fff}
      button{margin-top:12px;cursor:pointer}:disabled{opacity:.5;cursor:default}select:focus-visible,button:focus-visible{outline:2px solid var(--primary, var(--q-primary, currentColor));outline-offset:3px}
    </style><h2>Sortie Chromecast</h2>
    <p>Choisissez une sortie Windows inutilisée, par exemple celle d’un écran secondaire.</p>
    <p>Cette sortie restera muette pendant la diffusion. Réservez-la à Cider : ne l’utilisez pas pour d’autres applications.</p>
    <label for="reserved-output">Sortie Windows réservée</label><select id="reserved-output" aria-describedby="settings-status"></select>
    <button type="button" data-refresh>Actualiser les sorties</button><p id="settings-status" role="status" aria-live="polite"></p>`;
    this.shadowRoot.querySelector('select').onchange = event => { if (event.target.value) void audioSettings.select(event.target.value); };
    this.shadowRoot.querySelector('button').onclick = () => audioSettings.refresh();
    settingsPanels.add(this); this.render(); void audioSettings.refresh();
  }
  disconnectedCallback() { settingsPanels.delete(this); }
  render() {
    const { outputs, busy, locked, pendingRecovery, error, saved } = audioSettings.state;
    const select = this.shadowRoot.querySelector('select');
    const signature = JSON.stringify(outputs);
    if (signature !== this.signature) {
      this.signature = signature;
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choisir une sortie inutilisée…'; placeholder.disabled = true;
      select.replaceChildren(placeholder, ...outputs.map(output => {
        const option = document.createElement('option'); option.value = output.id;
        option.textContent = output.name + (output.isDefault ? ' — sortie Windows par défaut' : output.inUse ? ' — en cours de lecture' : '');
        option.disabled = output.isDefault || output.inUse; option.selected = output.selected; return option;
      }));
      if (!outputs.some(output => output.selected)) select.value = '';
    }
    select.value = outputs.find(output => output.selected)?.id ?? '';
    select.disabled = busy || locked || !!error;
    this.shadowRoot.querySelector('button').disabled = busy;
    this.shadowRoot.querySelector('[role="status"]').textContent = error || (pendingRecovery ? 'Une ancienne sortie attend sa restauration. Reconnectez-la puis fermez et rouvrez Cider avant de modifier ce réglage.'
      : locked ? 'La sortie est réservée pour cette session. Fermez puis rouvrez Cider avant de la changer.' : busy ? 'Lecture des sorties Windows…'
      : saved ? 'Sortie enregistrée. Revenez à Sortie audio pour connecter vos enceintes.' : !outputs.length ? 'Aucune sortie disponible. Connectez une sortie audio puis actualisez.' : 'Enregistré dès la sélection. Les sorties par défaut ou en cours de lecture sont indisponibles.');
  }
}
export default {
  identifier: 'local.marshall-cast', ce_prefix: 'marshall-isolated', name: 'Cider Cast',
  description: 'Diffuse uniquement Cider vers Google Cast. Service Windows 11 requis.',
  version: VERSION, author: release.author, repo: release.repo, pluginKitVersion: 4,
  SettingsElement: 'marshall-isolated-settings',
  setup() {
    if (!customElements.get('marshall-isolated-settings')) customElements.define('marshall-isolated-settings', AudioSettingsPanel);
    if (!customElements.get('marshall-isolated-panel')) customElements.define('marshall-isolated-panel', OutputPanel);
    window.__PLUGINSYS__.Components.CustomButtons.addCustomButton({ location: 'chrome-top/right', element: 'Cider Cast', title: 'Choisir la sortie audio', menuElement: 'marshall-isolated-panel' });
    installSpeakerIcon();
    nativeVolume = createNativeVolume(window, control);
    const diagnostic = createPlaybackDiagnostic(document, data => request('/diagnostic', data));
    diagnostic.sample();
    void control.refresh();
    let ticks = 0;
    timer = setInterval(() => { void control.refresh(); diagnostic.sample(); if (panels.size && ++ticks % 15 === 0) void control.discover(); }, 2000);
    window.addEventListener('pagehide', () => {
      try { nativeVolume.close(); } catch { /* Audio cleanup must still run if the host volume changed. */ }
      clearInterval(timer);
      diagnostic.close();
      const id = control.state.status?.id;
      if (id) void getConnection().getToken().then(token => fetch('http://127.0.0.1:27275/stop?id=' + id, { method: 'POST', headers: { 'X-Marshall-Token': token, 'Content-Type': 'application/json' }, body: '{}', keepalive: true })).catch(() => {});
    }, { once: true });
  },
};
