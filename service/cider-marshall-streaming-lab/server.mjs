import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAudioBridge } from './audio-bridge.mjs';
import { discover, discoverDevices } from '../cider-marshall-isolated/discover.mjs';
import { Streaming } from './streaming.mjs';
import { createDiagnosticLog, failureCode } from './diagnostic-log.mjs';
import { createOutputSettings } from './audio-outputs.mjs';
const capturePath = fileURLToPath(new URL('./native/capture.exe', import.meta.url));
const wavCapturePath = fileURLToPath(new URL('../cider-marshall-isolated/native/capture.exe', import.meta.url));
function authorized(req, token) {
  return /^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '') &&
    (!req.headers.origin || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(req.headers.origin)) &&
    (req.method === 'OPTIONS' || req.headers['x-marshall-token'] === token);
}

// Windows callbacks can arrive later than 20 ms; account for elapsed time, with bounded catch-up.
export function silenceFramesDue(elapsedMs, sentFrames) {
  return Math.max(0, Math.min(10, Math.floor(elapsedMs / 20) - sentFrames));
}

// Streaming uses its own capture binary and the shared Windows restoration journal.
export function createService(config, runtime = { createAudioBridge, discover, Streaming, spawn }, log = () => {}) {
  config = { ...config };
  const outputSettings = runtime.outputSettings ?? createOutputSettings(capturePath, fileURLToPath(new URL('./audio-output.json', import.meta.url)));
  if (!/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Configuration invalide.');
  let session, bridge, busy = false, returning = false, needsRestart = false, shuttingDown = false, lastError = '', shutdown = Promise.resolve();
  let lastStats = null;
  let deviceList = [], discoveryAt = 0, discoveryPromise, discoveryReady, discoveryError = '';
  async function listDevices(force = false) {
    if (!discoveryPromise && (force || Date.now() - discoveryAt > 15000)) {
      let ready;
      discoveryReady = new Promise(resolve => ready = resolve);
      discoveryError = '';
      discoveryPromise = Promise.resolve().then(() => (runtime.discoverDevices ?? discoverDevices)(4000, undefined, devices => {
        deviceList = devices;
        if (devices.length) ready();
      })).then(devices => {
        deviceList = devices; discoveryAt = Date.now();
      }).catch(() => {
        discoveryError = 'Découverte réseau indisponible. Vérifiez la connexion Wi-Fi puis réessayez.';
        deviceList = []; discoveryAt = Date.now();
      }).finally(() => { discoveryPromise = null; ready(); });
    }
    // Return early announcements, while the same scan keeps collecting slower devices.
    if (discoveryPromise && !deviceList.length) await discoveryReady;
    const devices = deviceList.map(d => ({ id: d.id, name: d.name, model: d.model, group: d.group, available: true, knownPair: d.name === config.target }));
    if (session?.device?.id && !devices.some(d => d.id === session.device.id)) devices.unshift({ id: session.device.id, name: session.device.name, group: session.device.group, available: false });
    return { devices, discoveredAt: discoveryAt, discovering: !!discoveryPromise, ...(discoveryError ? { error: discoveryError } : {}) };
  }
  const recoveryPending = () => runtime.recoveryPending?.() ?? fs.existsSync(fileURLToPath(new URL('../cider-marshall-isolated/native/route-restore.txt', import.meta.url)));
  async function stop(reason = '') {
    const s = session; session = null;
    if (!s) {
      if (reason) { log('secondary_error', { code: failureCode(reason) }); lastError ||= reason; }
      return shutdown;
    }
    lastError = reason;
    returning = true;
    log('stop', { ...s.transport?.stats, code: failureCode(reason), queueMs: s.transport?.queueMs, maxQueueMs: s.maxQueueMs, bytes: s.bytes });
    clearInterval(s.timer);
    clearInterval(s.silenceTimer);
    const pending = bridge?.routed === false ? bridge : null;
    if (pending) bridge = null;
    const released = pending?.close();
    if (!pending && bridge) {
      try { bridge.setLocal(true); bridge.resume?.(); log('local_return'); }
      catch (e) { log('secondary_error', { code: failureCode(e.message) }); lastError ||= e.message; needsRestart = true; }
    }
    shutdown = (async () => {
      try { await s.transport?.close(); }
      catch { lastError ||= 'La connexion aux enceintes ne s’est pas fermée normalement.'; }
      finally {
        if (s.transport?.cleanupUnconfirmed) lastError ||= 'Arrêt du récepteur à vérifier.';
        try {
          if (released) await released;
        }
        catch (e) { log('secondary_error', { code: failureCode(e.message) }); lastError ||= e.message; needsRestart = true; }
        lastStats = { ...s.transport?.stats, maxQueueMs: s.maxQueueMs };
        returning = false;
      }
    })();
    return shutdown;
  }
  async function ensureBridge() {
    if (!bridge) {
      const current = runtime.createAudioBridge(config, {
        diagnostic: log,
        audio(data, peak) {
          const s = session; if (!s || !s.transport?.ready) return;
          s.peak = peak; s.bytes += data.length;
          if (peak > 0.00001) s.hasAudio = true;
          try { const writable = s.transport.write(data); s.maxQueueMs = Math.max(s.maxQueueMs, s.transport.queueMs); return writable; }
          catch (e) { void stop(e.message); }
        },
        error(message, details) { if (bridge === current) { needsRestart = details?.needsRestart ?? !message.startsWith('Lancez un morceau audible'); void stop(message); } },
        closed(unexpected) {
          log('bridge_closed');
          if (bridge !== current) return;
          bridge = null;
          if (unexpected) { needsRestart = true; void stop('Le lecteur audio de Cider s’est fermé. Relancez Cider pour reconnecter les enceintes.'); }
          else void stop();
        },
      }, (exe, args, options) => {
        const child = runtime.spawn(exe === wavCapturePath ? capturePath : exe, args, options);
        if (exe === wavCapturePath || exe === capturePath) {
          let pending = '';
          child.stderr.on('data', chunk => {
            pending = (pending + chunk.toString()).slice(-2048);
            const match = pending.match(/(?:^|\n)CAPTURE (\d+)\r?\n/);
            if (match) { log('capture_source', { pid: Number(match[1]) }); pending = ''; }
          });
        }
        return child;
      });
      bridge = current;
    }
    await bridge.ready;
  }
  async function recover() {
    await shutdown;
    if (bridge) return;
    const helper = runtime.spawn(capturePath, [config.endpointId, '--restore'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let nativeError = '';
    helper.stderr.on('data', data => { const match = data.toString().match(/ERROR (0x[\da-f]{8})/i); if (match) nativeError = match[1].toLowerCase(); });
    helper.stderr.resume();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { helper.kill(); reject(new Error('Restauration Windows trop longue. Relancez Cider avec le contrôleur ouvert.')); }, 8000);
      helper.once('error', error => { clearTimeout(timer); reject(error); });
      helper.once('exit', code => {
        clearTimeout(timer);
        const message = nativeError === '0x8007048f' ? 'La sortie Windows réservée est absente. Reconnectez-la puis rouvrez Cider.'
          : nativeError === '0x80070034' ? 'Plusieurs sorties correspondent à la sortie réservée. Restauration refusée par sécurité.'
          : nativeError === '0x80070005' ? 'La sortie réservée est désactivée ou utilisée par défaut. Vérifiez les réglages audio Windows.' : 'Restauration Windows incomplète.';
        code === 0 ? resolve() : reject(new Error(message));
      });
    });
    needsRestart = false; lastError = '';
  }
  async function start(data) {
    await shutdown;
    const s = { id: crypto.randomBytes(24).toString('hex'), bytes: 0, peak: 0, hasAudio: false, maxQueueMs: 0, state: 'Négociation Cast Streaming', lastSeen: Date.now() };
    session = s; lastError = ''; lastStats = null;
    const device = await runtime.discover(data.deviceId ?? config.target, config.localAddress);
    if (session !== s) throw new Error('Connexion annulée.');
    s.device = device;
    log('start', { targetDelayMs: data.delayMs ?? 400, adaptive: data.adaptive === true });
    s.transport = new runtime.Streaming(device, {
      diagnostic: log,
      drain() { if (session === s) { s.silenceBlocked = false; bridge?.resume?.(); } },
      error(message) { if (session === s) void stop(message); },
      stats(stats) {
        if (session !== s) return;
        if (!s.lastLogAt || Date.now() - s.lastLogAt >= 5000) {
          log('stats', { ...stats, queueMs: s.transport.queueMs, maxQueueMs: s.maxQueueMs }); s.lastLogAt = Date.now();
        }
        if (stats.feedback > 0 && stats.feedbackAgeMs <= 5000 && s.hasAudio) {
          s.state = 'Cast Streaming · réception confirmée';
          try { bridge?.setLocal(false); } catch (e) { void stop(e.message); }
        }
      },
    }, { delayMs: data.delayMs ?? 400, adaptive: data.adaptive === true });
    await s.transport.open();
    if (session !== s) throw new Error('Diffusion interrompue.');
    s.state = 'Cast connecté · en attente de lecture'; s.lastSeen = Date.now();
    // Keep the receiver and its audio clock alive without routing a silent Cider session.
    const silence = Buffer.alloc(7680 * 10), silenceSince = performance.now();
    let silentFrames = 0;
    s.silenceTimer = setInterval(() => {
      if (session !== s || s.captureReady || s.silenceBlocked) return;
      const frames = silenceFramesDue(performance.now() - silenceSince, silentFrames);
      if (!frames) return;
      try { s.silenceBlocked = s.transport.write(silence.subarray(0, frames * 7680)) === false; silentFrames += frames; }
      catch (e) { void stop(e.message); }
    }, 20);
    void ensureBridge().then(() => {
      if (session !== s) return;
      s.captureReady = true; clearInterval(s.silenceTimer);
      s.state = 'Cast Streaming · envoi audio';
    }).catch(e => { if (session === s) void stop(e.message); });
    s.timer = setInterval(() => {
      // WebView2 can throttle background page timers to one minute.
      if (Date.now() - s.lastSeen > 90000) void stop('Cider ne répond plus.');
    }, 1000);
    return { id: s.id };
  }
  const control = http.createServer(async (req, res) => {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'X-Marshall-Token, Content-Type', 'Access-Control-Allow-Private-Network': 'true' };
    if (/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(req.headers.origin ?? '')) headers['Access-Control-Allow-Origin'] = req.headers.origin;
    const send = (code, result) => { res.writeHead(code, headers); res.end(JSON.stringify(result)); };
    if (!authorized(req, config.token)) return send(403, { error: 'Accès refusé.' });
    if (req.method === 'OPTIONS') return send(204, null);
    if (shuttingDown) return send(503, { error: 'Le service audio s’arrête.' });
    try {
      if (req.method === 'GET' && req.url === '/status') {
        const s = session;
        const pendingRecovery = !bridge && recoveryPending();
        const output = bridge?.available === false ? 'unavailable' : bridge?.routed === false ? 'direct' : bridge ? (bridge.local ? 'pc' : 'cast') : (needsRestart || pendingRecovery ? 'unavailable' : 'direct');
        const phase = returning ? 'returning' : s ? (output === 'cast' ? 'casting' : s.transport?.ready && !s.hasAudio ? 'waiting' : 'connecting') : busy ? 'recovering' : needsRestart ? 'error' : pendingRecovery ? 'restore-pending' : 'pc';
        return send(200, { version: '1.0.0-rc.2', build: 'cider-cast-marketplace-rc2', diagnosticsDropped: log.dropped ?? 0, format: 'opus-cast-rtp', setupRequired: !config.endpointId, active: !!s, id: s?.id, deviceId: s?.device?.id, name: s?.device?.name ?? config.target, volume: s?.transport?.volume ?? null, volumeError: s?.transport?.volumeError ?? '', phase, needsRestart, pendingRecovery, state: s?.state ?? (bridge ? 'Retour PC via le relais local' : 'Arrêtée'), output, bytes: s?.bytes ?? 0, peak: s?.peak ?? 0, receiverState: s?.transport?.stats.feedback > 0 ? 'RTCP reçu' : '', receivers: s?.transport?.stats.feedback > 0 ? 1 : 0, error: lastError || (pendingRecovery ? 'Fermez puis rouvrez Cider pour rétablir sa sortie audio.' : ''), timing: s ? { ...s.transport?.stats, queueMs: s.transport?.queueMs, maxQueueMs: s.maxQueueMs } : lastStats });
      }
      if (req.method === 'GET' && req.url === '/devices') return send(200, await listDevices());
      if (req.method === 'GET' && req.url === '/audio-outputs') return send(200, { outputs: await outputSettings.list(config.endpointId), locked: !!(session || bridge || busy || returning || recoveryPending()), pendingRecovery: !bridge && recoveryPending() });
      if (req.method !== 'POST') return send(404, { error: 'Route inconnue.' });
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 8192) throw new Error('Requête trop volumineuse.'); }
      const data = JSON.parse(body || '{}');
      if (!data || typeof data !== 'object' || Array.isArray(data)) return send(400, { error: 'Requête invalide.' });
      if (req.url === '/audio-output') {
        if (session || bridge || busy || returning || recoveryPending()) return send(409, { error: 'Fermez puis rouvrez Cider pour terminer la session et sa restauration avant de changer la sortie réservée.' });
        if (Object.keys(data).length !== 1 || typeof data.endpointId !== 'string') return send(400, { error: 'Sortie Windows invalide.' });
        busy = true;
        try { config.endpointId = await outputSettings.save(data.endpointId, config.endpointId); return send(200, { saved: true }); }
        finally { busy = false; }
      }
      if (req.url === '/local') {
        await stop();
        if (bridge?.available !== false && bridge) {
          try { bridge.setLocal(true); bridge.resume?.(); }
          catch { needsRestart = true; }
        }
        if (needsRestart || (!bridge && recoveryPending())) return send(409, { error: 'Fermez puis rouvrez Cider pour rétablir la sortie PC.' });
        lastError = ''; return send(200, { local: true });
      }
      if (req.url === '/shutdown') {
        if (session || bridge || busy || returning) return send(409, { error: 'Fermez Cider avant d’arrêter le service audio.' });
        shuttingDown = true; send(200, { stopped: true });
        control.close(); return;
      }
      if (req.url === '/devices/refresh') return send(200, await listDevices(true));
      if (req.url === '/diagnostic') { log('playback', data); return send(200, { accepted: true }); }
      if (req.url === '/recover') {
        if (busy || session) return send(409, { error: 'Diffusion en cours.' });
        busy = true; try { await recover(); return send(200, { restored: true }); } catch (e) { needsRestart = true; lastError = e.message; throw e; } finally { busy = false; }
      }
      if (req.url === '/start') {
        if (busy || session) return send(409, { error: 'Diffusion en cours.' });
        if (!config.endpointId) return send(409, { error: 'Choisissez une sortie Chromecast dans les réglages de Cider Cast avant de connecter les enceintes.' });
        if (data.version !== '1.0.0-rc.2') return send(409, { error: 'Redémarrez Cider pour charger la nouvelle version du plugin.' });
        if (needsRestart) return send(409, { error: lastError || 'Relancez Cider avant de reconnecter les enceintes.' });
        if (data.deviceId !== undefined && (typeof data.deviceId !== 'string' || !data.deviceId.length || data.deviceId.length > 512)) return send(400, { error: 'Appareil Cast invalide.' });
        if ((data.delayMs !== undefined && (!Number.isInteger(data.delayMs) || data.delayMs < 100 || data.delayMs > 1000)) || (data.adaptive !== undefined && typeof data.adaptive !== 'boolean')) return send(400, { error: 'Réglage du délai invalide.' });
        busy = true;
        try { return send(200, await start(data)); }
        catch (e) { if (!session && ['Connexion annulée.', 'Diffusion interrompue.'].includes(e.message)) return send(409, { error: 'Connexion annulée.' }); await stop(e.message); throw e; }
        finally { busy = false; }
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!session || url.searchParams.get('id') !== session.id) return send(409, { error: 'Session expirée.' });
      if (url.pathname === '/volume') return send(200, { volume: await session.transport.setVolume(data) });
      if (url.pathname === '/stop') { await stop(); return send(200, { stopped: true, error: lastError }); }
      if (url.pathname === '/heartbeat') { session.lastSeen = Date.now(); return send(200, { active: true }); }
      send(404, { error: 'Route inconnue.' });
    } catch (e) { if (!res.headersSent) send(400, { error: e.message }); }
  });
  control.requestTimeout = 15000; control.headersTimeout = 10000;
  return { control, stop, async close() { await stop(); await bridge?.close(); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(fs.readFileSync(new URL('../cider-marshall-isolated/config.json', import.meta.url)));
  const outputSettings = createOutputSettings(capturePath, fileURLToPath(new URL('./audio-output.json', import.meta.url)));
  config.endpointId = outputSettings.load() ?? config.endpointId;
  const log = createDiagnosticLog(fileURLToPath(new URL('./diagnostic-temp.jsonl', import.meta.url)));
  const service = createService(config, undefined, log);
  log('controller_ready');
  service.control.on('error', e => { console.error(e.message); process.exitCode = 1; });
  service.control.listen(27275, '127.0.0.1', () => console.log('Cast Streaming audio : contrôleur expérimental prêt.'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await service.close(); service.control.close(); });
}
