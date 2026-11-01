import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function validPCM(buffer) {
  if (!buffer.length || buffer.length > 131072 || buffer.length % 8) return false;
  for (let i = 0; i < buffer.length; i += 4) {
    const value = buffer.readFloatLE(i);
    if (!Number.isFinite(value) || Math.abs(value) > 16) return false;
  }
  return true;
}

// Keep the Windows route alive when Cast stops: changing it back can stall Cider.
export function createAudioBridge(config, { audio, error, closed, diagnostic = () => {} }, launch = spawn) {
  const playbackPath = config.playerPath ?? path.join(path.dirname(config.ffmpeg), 'ffplay.exe');
  if (launch === spawn && !fs.existsSync(playbackPath)) throw new Error('FFplay est nécessaire pour le retour sur le PC.');
  let native, player, ending = false, local = true, routed = false, restorePending = false, pending = Buffer.alloc(0);
  let resolveReady, rejectReady, resolveClosed;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const ended = new Promise(resolve => { resolveClosed = resolve; });
  let timer, pcTimer, pcBlocked = false, castBlocked = false;
  function resumeCapture() { if (!ending && !pcBlocked && !castBlocked) native?.stdout.resume(); }
  function stopPlayer() {
    const previous = player; player = null;
    clearTimeout(pcTimer); pcBlocked = false;
    previous?.kill();
    resumeCapture();
  }
  function fail(message, details) {
    if (ending) return;
    rejectReady(new Error(message));
    close(); error(message, details);
  }
  function playOnPC() {
    if (ending || player) return;
    const p = launch(playbackPath, [
      '-hide_banner', '-loglevel', 'error', '-nodisp', '-autoexit',
      '-probesize', '32', '-analyzeduration', '0',
      '-f', 'f32le', '-sample_rate', '48000', '-ch_layout', 'stereo', '-i', 'pipe:0',
    ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    player = p; p.stderr.resume();
    p.stdin.on('error', () => { if (player === p) fail('Le relais vers le PC est interrompu. Relancez Cider.'); });
    p.on('error', () => { if (player === p) fail('Le lecteur local est indisponible. Relancez Cider.'); });
    p.on('exit', () => { if (player === p) fail('Le lecteur local s’est arrêté. Relancez Cider.'); });
  }
  function close() {
    if (ending) return ended;
    ending = true; clearTimeout(timer); stopPlayer();
    native?.stdout.resume(); // Drain the pipe so a paused producer can finish closing.
    rejectReady(new Error('Relais Windows arrêté.'));
    native?.stdin.end();
    return ended;
  }
  function setLocal(enabled) {
    if (ending) throw new Error('Le relais Windows est arrêté. Relancez Cider.');
    if (local === enabled) return;
    local = enabled;
    if (local) playOnPC(); else stopPlayer();
  }
  function resume() { castBlocked = false; resumeCapture(); }
  native = launch(fileURLToPath(new URL('./native/capture.exe', import.meta.url)), [config.endpointId], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  native.stdin.on('error', () => {});
  let log = '', stage = 'startup';
  function captureLine(line) {
    const timing = line.match(/^CAPTURE_TIMING (\d+) (\d+) (\d+) ([01])$/);
    if (timing) {
      const [maxPacketGapMs, maxPacketAgeMs, qpcPackets, mmcssActive] = timing.slice(1).map(Number);
      diagnostic('capture_timing', { maxPacketGapMs, maxPacketAgeMs, qpcPackets, mmcssActive });
    }
    const metrics = line.match(/^CAPTURE_STATS (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)$/);
    if (metrics) {
      const [capturedFrames, discontinuities, timestampErrors, missingFrames, maxProbeMs, maxWriteMs] = metrics.slice(1).map(Number);
      diagnostic('capture_stats', { capturedFrames, discontinuities, timestampErrors, missingFrames, maxProbeMs, maxWriteMs });
    }
    const step = line.match(/^STAGE ([a-z-]+)$/);
    if (step) {
      stage = step[1]; diagnostic('capture_stage', { stage });
      if (stage === 'selection') clearTimeout(timer);
      if (stage === 'route') {
        routed = true;
        timer = setTimeout(() => fail('Aucun flux reçu de Windows. Relancez Cider.'), 22000);
      }
    }
    const source = line.match(/^CAPTURE (\d+)$/);
    if (source) diagnostic('capture_source', { pid: Number(source[1]) });
    const failure = line.match(/^ERROR (0x[\da-f]{8}|recovery-file)$/i);
    if (failure) {
      const hresult = failure[1].toLowerCase();
      diagnostic('capture_error', { hresult, stage });
      const sourceNotReady = hresult === '0x80070490' && ['startup', 'selection'].includes(stage);
      const defaultOutput = hresult === '0x80070005' && stage === 'default-check';
      const ambiguousSource = hresult === '0x80070034' && stage === 'selection';
      const missingOutput = hresult === '0x8007048f' && stage === 'endpoint';
      const ambiguousOutput = hresult === '0x80070034' && stage === 'endpoint';
      const occupiedOutput = hresult === '0x800700aa' && stage === 'selection';
      fail(sourceNotReady ? 'Lancez un morceau audible dans Cider avant de diffuser.'
        : defaultOutput ? 'La sortie réservée est une sortie Windows par défaut. Choisissez votre sortie PC pour les communications Windows, puis réessayez.'
        : ambiguousSource ? 'Plusieurs sources audio Cider sont actives. Réessayez une fois la transition terminée.'
        : missingOutput ? 'La sortie Windows réservée est absente. Reconnectez-la puis réessayez.'
        : ambiguousOutput ? 'Plusieurs sorties Windows correspondent à la sortie réservée. Aucune sortie n’a été modifiée.'
        : occupiedOutput ? 'La sortie réservée est utilisée. Arrêtez sa lecture avant de réessayer.'
        : `Capture Windows : ${hresult}. Relancez Cider.`, { needsRestart: !sourceNotReady && !defaultOutput && !ambiguousSource && !missingOutput && !ambiguousOutput && !occupiedOutput });
    }
    if (line === 'RESTORE_PENDING') { restorePending = true; diagnostic('restoration_pending'); }
  }
  native.stderr.on('data', data => {
    log += data.toString();
    if (log.length > 8192) { log = ''; diagnostic('capture_stderr_invalid'); return; }
    let newline;
    while ((newline = log.indexOf('\n')) >= 0) {
      const line = log.slice(0, newline).replace(/\r$/, ''); log = log.slice(newline + 1);
      captureLine(line);
    }
  });
  native.on('error', () => {
    fail('Module Windows indisponible.'); resolveClosed(); closed(true);
  });
  native.on('close', code => {
    if (log) { captureLine(log.replace(/\r$/, '')); log = ''; }
    diagnostic('capture_exit', { exitCode: code });
    const unexpected = !ending && code !== 0;
    ending = true; clearTimeout(timer); stopPlayer();
    rejectReady(new Error('Capture Windows arrêtée.'));
    resolveClosed(); closed(unexpected, { restorePending });
    if (unexpected) error('La session audio de Cider s’est fermée.');
  });
  native.stdout.on('data', chunk => {
    if (ending) return;
    const all = Buffer.concat([pending, chunk]), size = all.length - all.length % 8;
    const data = all.subarray(0, size); pending = all.subarray(size);
    if (!size) return;
    if (!validPCM(data)) { fail('Signal Windows invalide. Relancez Cider.'); return; }
    clearTimeout(timer); resolveReady();
    let peak = 0;
    for (let i = 0; i < data.length; i += 4) peak = Math.max(peak, Math.abs(data.readFloatLE(i)));
    if (local && player) {
      if (player.stdin.writableLength + data.length > 384000) { fail('Le relais PC est saturé. Relancez Cider.'); return; }
      const p = player;
      if (!p.stdin.write(data)) {
        pcBlocked = true; native.stdout.pause();
        pcTimer = setTimeout(() => { if (player === p && pcBlocked) fail('Le relais vers le PC est bloqué. Fermez puis rouvrez Cider.'); }, 1000);
        p.stdin.once('drain', () => {
          if (player !== p) return;
          clearTimeout(pcTimer); pcBlocked = false; resumeCapture();
        });
      }
    }
    if (audio(data, peak) === false) { castBlocked = true; native.stdout.pause(); }
  });
  timer = setTimeout(() => fail('Aucun flux reçu de Windows. Relancez Cider.'), 22000);
  playOnPC();
  return { ready, ended, setLocal, close, resume, get local() { return local; }, get routed() { return routed; }, get available() { return !ending; } };
}
