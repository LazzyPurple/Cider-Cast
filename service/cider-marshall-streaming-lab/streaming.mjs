import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { observeSenderErrors } from './diagnostic-log.mjs';
import { validPCM } from './audio-bridge.mjs';
const require = createRequire(new URL('../cider-marshall-isolated/package.json', import.meta.url));
const { Client } = require('castv2');
const appId = '85CDB22F', receiverNS = 'com.google.cast.receiver', streamNS = 'com.google.cast.webrtc';

export function receiverVolume(value) {
  if (!Number.isFinite(value?.level) || value.level < 0 || value.level > 1 || typeof value.muted !== 'boolean') return null;
  return { level: value.level, muted: value.muted, adjustable: value.controlType !== 'fixed' };
}

export function validateAnswer(message) {
  assert.equal(message.type, 'ANSWER');
  if (message.result !== 'ok') {
    const code = Number.isInteger(message.error?.code) ? ` (code ${message.error.code})` : '';
    const description = typeof message.error?.description === 'string' ? message.error.description.replace(/[a-f0-9]{32,}/gi, '[masqué]').replace(/[\r\n]+/g, ' ').slice(0, 200) : '';
    throw new Error(`Offre audio refusée par l’appareil Cast${code}${description ? ' : ' + description : '.'}`);
  }
  const a = message.answer;
  assert.ok(Number.isInteger(a?.udpPort) && a.udpPort > 0 && a.udpPort <= 65535, 'Port UDP invalide');
  assert.deepEqual(a.sendIndexes, [0], 'Flux audio non sélectionné');
  assert.ok(Array.isArray(a.ssrcs) && a.ssrcs.length === 1 && Number.isInteger(a.ssrcs[0]) && a.ssrcs[0] >= 0 && a.ssrcs[0] <= 0xffffffff, 'SSRC invalide');
  const limits = a.constraints?.audio;
  if (limits) {
    assert.ok((limits.maxChannels ?? 2) >= 2 && (limits.maxSampleRate ?? 48000) >= 48000 && (limits.maxBitRate ?? 128000) >= 128000 && (limits.minBitRate ?? 0) <= 128000, 'Paramètres audio incompatibles');
  }
  return { port: a.udpPort, receiverSsrc: a.ssrcs[0], maxDelay: limits?.maxDelay ?? null };
}

export function createAudioStream(delayMs) {
  assert.ok(Number.isInteger(delayMs) && delayMs >= 100 && delayMs <= 1000);
  // These Marshall reject unsigned SSRCs above INT32_MAX with a misleading codec error.
  return { index: 0, type: 'audio_source', codecName: 'opus', rtpProfile: 'cast', rtpPayloadType: 96, ssrc: randomInt(1, 0x7fffffff), targetDelay: delayMs, aesKey: randomBytes(16).toString('hex'), aesIvMask: randomBytes(16).toString('hex'), timeBase: '1/48000', sampleRate: 48000, bitRate: 128000, channels: 2, receiverRtcpEventLog: false };
}

export class Streaming {
  constructor(device, hooks = {}, options = {}) {
    assert.ok(/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|127\.0\.0\.1$)/.test(device.host), 'Récepteur hors réseau local');
    assert.ok(Number.isInteger(device.port) && device.port > 0 && device.port <= 65535);
    this.device = device; this.hooks = hooks; this.options = { delayMs: 400, adaptive: false, ...options };
    assert.ok(Number.isInteger(this.options.delayMs) && this.options.delayMs >= 100 && this.options.delayMs <= 1000);
    this.client = new Client(); this.sender = 'marshall-streaming-' + randomBytes(8).toString('hex'); this.nextId = 1;
    this.pending = new Set(); this.stats = {}; this.closing = false; this.failure = null;
    this.client.on('error', () => this.fail('Connexion de contrôle Cast interrompue.'));
    this.client.on('close', () => { if (!this.closing) this.fail('Connexion de contrôle Cast fermée.'); });
    this.client.on('message', (source, target, ns, data) => {
      if (source === 'receiver-0' && (target === this.sender || target === '*') && ns === 'urn:x-cast:' + receiverNS) {
        try { const message = JSON.parse(data); if (message.type === 'RECEIVER_STATUS') this.volume = receiverVolume(message.status?.volume); } catch {}
      }
      if (ns !== 'urn:x-cast:com.google.cast.tp.heartbeat') return;
      try { if (JSON.parse(data).type === 'PING') this.send(source, 'com.google.cast.tp.heartbeat', { type: 'PONG' }); } catch {}
    });
  }
  send(destination, ns, data) { this.client.send(this.sender, destination, 'urn:x-cast:' + ns, JSON.stringify(data)); }
  request(destination, ns, data, key = 'requestId', timeout = 10000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.client.off('message', receive); this.pending.delete(cancel); };
      const cancel = () => { cleanup(); reject(new Error('Commande Cast interrompue : ' + data.type)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Réponse Cast absente : ' + data.type)); }, timeout);
      const receive = (source, target, namespace, bytes) => {
        if (source !== destination || (target !== this.sender && target !== '*') || namespace !== 'urn:x-cast:' + ns) return;
        let message; try { message = JSON.parse(bytes); } catch { return; }
        if (message[key] !== id) return;
        cleanup(); resolve(message);
      };
      this.pending.add(cancel); this.client.on('message', receive);
      try { this.send(destination, ns, { ...data, [key]: id }); } catch { cancel(); }
    });
  }
  fail(message) {
    if (this.closing || this.failure) return;
    this.failure = message; for (const cancel of [...this.pending]) cancel();
    this.hooks.error?.(message);
  }
  open() { return this.opening ??= this.connect(); }
  async connect() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Connexion Cast trop longue.')), 8000);
      this.client.once('error', () => { clearTimeout(timer); reject(new Error('Connexion Cast impossible.')); });
      this.client.connect(this.device, () => { clearTimeout(timer); resolve(); });
    });
    this.send('receiver-0', 'com.google.cast.tp.connection', { type: 'CONNECT' });
    const state = await this.request('receiver-0', receiverNS, { type: 'GET_STATUS' });
    this.volume = receiverVolume(state.status?.volume);
    assert.ok((state.status?.applications ?? []).every(a => a.appId === 'CC1AD845'), 'Une autre application Cast est active.');
    const launch = await this.request('receiver-0', receiverNS, { type: 'LAUNCH', appId });
    this.app = launch.status?.applications?.find(a => a.appId === appId);
    assert.ok(this.app?.transportId && this.app?.sessionId, 'Lancement du récepteur audio refusé.');
    if (this.closing) throw new Error('Diffusion annulée.');
    this.send(this.app.transportId, 'com.google.cast.tp.connection', { type: 'CONNECT' });
    const stream = createAudioStream(this.options.delayMs);
    const result = validateAnswer(await this.request(this.app.transportId, streamNS, { type: 'OFFER', offer: { castMode: 'mirroring', supportedStreams: [stream] } }, 'seqNum'));
    if (result.maxDelay !== null) assert.ok(result.maxDelay >= this.options.delayMs, 'Délai demandé incompatible.');
    if (this.closing) throw new Error('Diffusion annulée.');
    this.helper = spawn(fileURLToPath(new URL('../runtime/dotnet/dotnet.exe', import.meta.url)), [fileURLToPath(new URL('./sender/bin/Release/net10.0/Sender.dll', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const helper = this.helper;
    const log = (event, data) => this.hooks.diagnostic?.(event, data);
    observeSenderErrors(helper, log, () => this.closing, () => this.fail('Erreur réseau de l’émetteur audio. Retour sur le PC.'));
    helper.stdin.on('error', () => { log('sender_pipe_error', { queueMs: this.queueMs, expected: this.closing }); this.fail('Émetteur audio interrompu.'); });
    helper.on('error', () => { log('sender_spawn_error'); this.fail('Émetteur audio indisponible.'); });
    helper.on('exit', () => this.fail('Émetteur audio arrêté.'));
    this.ended = new Promise(resolve => { helper.once('exit', resolve); helper.once('error', resolve); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Émetteur audio non initialisé.')), 5000);
      let text = '';
      helper.stdout.on('data', chunk => {
        text += chunk.toString();
        if (text.length > 16384) { this.fail('Diagnostic émetteur invalide.'); return; }
        let newline;
        while ((newline = text.indexOf('\n')) >= 0) {
          const line = text.slice(0, newline); text = text.slice(newline + 1);
          let data; try { data = JSON.parse(line); } catch { this.fail('Diagnostic émetteur invalide.'); continue; }
          if (data.type === 'ready') { clearTimeout(timer); resolve(); }
          else if (data.type === 'stats') { this.stats = data; this.hooks.stats?.(data); }
          else if (data.type === 'failure' && data.code === 'SOURCE_CLOCK_LIMIT') this.fail('Le flux audio est désynchronisé. Retour sur le PC.');
        }
      });
      helper.once('error', () => { clearTimeout(timer); reject(new Error('Émetteur indisponible.')); });
      helper.once('exit', () => { clearTimeout(timer); reject(new Error('Émetteur arrêté.')); });
      const settings = Buffer.from(JSON.stringify({ Host: this.device.host, Port: result.port, Ssrc: stream.ssrc, Key: stream.aesKey, Iv: stream.aesIvMask, DelayMs: this.options.delayMs, Adaptive: this.options.adaptive, PayloadType: stream.rtpPayloadType }));
      const size = Buffer.alloc(4); size.writeUInt32LE(settings.length);
      helper.stdin.write(Buffer.concat([size, settings]));
    });
    this.ping = setInterval(() => {
      try { this.send('receiver-0', 'com.google.cast.tp.heartbeat', { type: 'PING' }); } catch { this.fail('Connexion Cast interrompue.'); }
      if (!this.volumePending) void this.refreshVolume().catch(() => {});
    }, 5000);
    this.ready = true;
  }
  write(data) {
    if (!this.ready || this.closing || this.failure) return;
    if (!validPCM(data)) throw new Error('PCM invalide.');
    const now = performance.now(), inputGapMs = this.lastWriteAt === undefined ? 0 : now - this.lastWriteAt;
    this.lastWriteAt = now;
    if (this.helper.stdin.writableLength + data.length > 192000) {
      this.hooks.diagnostic?.('input_queue_limit', { queueMs: this.queueMs, incomingMs: data.length / 384, projectedQueueMs: this.queueMs + data.length / 384, inputGapMs });
      throw new Error('File audio supérieure à 500 ms.');
    }
    const writable = this.helper.stdin.write(data);
    if (!writable && !this.queueTimer) {
      const blockedAt = performance.now();
      const drained = () => {
        clearTimeout(this.queueTimer); this.queueTimer = null;
        if (!this.closing && !this.failure) this.hooks.drain?.();
      };
      this.queueTimer = setTimeout(() => {
        this.helper.stdin.off('drain', drained);
        this.queueTimer = null;
        if (this.closing || this.failure) return;
        if (!this.helper.stdin.writableLength) { this.hooks.drain?.(); return; }
        this.hooks.diagnostic?.('sender_input_stalled', { queueMs: this.queueMs, elapsedMs: performance.now() - blockedAt });
        this.fail('L’émetteur audio ne consomme plus le son. Retour sur le PC.');
      }, 500);
      this.helper.stdin.once('drain', drained);
    }
    return writable;
  }
  get queueMs() { return (this.helper?.stdin.writableLength ?? 0) / 384; }
  async refreshVolume() {
    if (this.volumePending || this.closing) return;
    this.volumePending = true;
    try {
      const response = await this.request('receiver-0', receiverNS, { type: 'GET_STATUS' }, 'requestId', 2500);
      if (response.type !== 'RECEIVER_STATUS') throw new Error('Volume des enceintes indisponible.');
      this.volume = receiverVolume(response.status?.volume); this.volumeError = '';
    } catch { this.volume = null; this.volumeError = 'Volume des enceintes indisponible. Réessayez.'; }
    finally { this.volumePending = false; }
  }
  async setVolume(value) {
    if (!this.ready || this.closing || this.failure) throw new Error('La connexion Cast n’est pas prête.');
    if (!value || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).some(k => !['level', 'muted'].includes(k))
      || (value.level !== undefined && (!Number.isFinite(value.level) || value.level < 0 || value.level > 1))
      || (value.muted !== undefined && typeof value.muted !== 'boolean')) throw new Error('Volume invalide.');
    if (this.volume?.adjustable === false) throw new Error('Le volume de cet appareil est fixe.');
    const response = await this.request('receiver-0', receiverNS, { type: 'SET_VOLUME', volume: value }, 'requestId', 3000);
    const volume = response.type === 'RECEIVER_STATUS' ? receiverVolume(response.status?.volume) : null;
    if (!volume) throw new Error('Le réglage du volume n’a pas été confirmé par les enceintes.');
    this.volume = volume; this.volumeError = ''; return volume;
  }
  async diagnostics() {
    const receiver = await this.request('receiver-0', receiverNS, { type: 'GET_STATUS' }, 'requestId', 2000);
    const media = await this.request(this.app.transportId, 'com.google.cast.media', { type: 'GET_STATUS' }, 'requestId', 2000);
    return { volume: receiver.status?.volume, media: media.status?.map(s => ({ playerState: s.playerState, idleReason: s.idleReason, currentTime: s.currentTime, volume: s.volume, supportedMediaCommands: s.supportedMediaCommands })), mediaResponseType: media.type };
  }
  close() { return this.closed ??= this.cleanup(); }
  async cleanup() {
    this.closing = true; this.ready = false; clearInterval(this.ping);
    clearTimeout(this.queueTimer); this.queueTimer = null;
    await this.opening?.catch(() => {});
    clearInterval(this.ping);
    if (this.helper) {
      this.helper.stdin.end();
      const timer = setTimeout(() => this.helper.kill(), 1500);
      await this.ended; clearTimeout(timer);
    }
    try {
      if (this.app) {
        const status = await this.request('receiver-0', receiverNS, { type: 'GET_STATUS' }, 'requestId', 2500);
        if (status.status?.applications?.some(a => a.sessionId === this.app.sessionId && a.appId === appId)) await this.request('receiver-0', receiverNS, { type: 'STOP', sessionId: this.app.sessionId }, 'requestId', 2500);
      }
    } catch { this.cleanupUnconfirmed = true; }
    for (const cancel of [...this.pending]) cancel();
    this.client.socket?.destroy();
  }
}
