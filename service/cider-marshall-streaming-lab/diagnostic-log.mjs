import fs from 'node:fs';

const events = new Set(['sender_input_stalled', 'capture_stats', 'capture_timing', 'input_queue_limit', 'restoration_pending', 'capture_source', 'capture_stage', 'capture_error', 'capture_exit', 'capture_stderr_invalid', 'controller_ready', 'start', 'stop', 'secondary_error', 'bridge_closed', 'local_return', 'stats', 'sender_diagnostic', 'sender_exit', 'sender_pipe_error', 'sender_spawn_error', 'sender_stderr_invalid']);
const captureStages = new Set(['startup', 'endpoint', 'cider', 'recovery', 'default-check', 'selection', 'route', 'wait-route', 'activate', 'initialize', 'capture', 'source-wait']);
const codes = new Set(['SOCKET_FAILURE', 'SOCKET_RETRY', 'SOCKET_RETRANSMIT_FAILED', 'PC_RELAY_STALLED', 'SENDER_INPUT_STALLED', 'SOURCE_CLOCK_LIMIT', 'FEEDBACK_TIMEOUT', 'INPUT_EOF', 'EXCEPTION', 'USER_STOP', 'OTHER', 'PC_RELAY_SATURATED', 'PC_RELAY_INTERRUPTED', 'SENDER_INTERRUPTED', 'CIDER_HEARTBEAT_TIMEOUT', 'INPUT_QUEUE_LIMIT']);
const exceptions = new Set(['TimeoutException', 'EndOfStreamException', 'InvalidDataException', 'IOException', 'SocketException', 'ArgumentException', 'FormatException', 'CryptographicException']);
const socketStages = new Set(['sender', 'send-audio', 'send-report', 'retransmit']);
const numbers = ['maxPacketGapMs', 'maxPacketAgeMs', 'qpcPackets', 'mmcssActive', 'capturedFrames', 'discontinuities', 'timestampErrors', 'missingFrames', 'maxProbeMs', 'maxWriteMs', 'inputReadP95Ms', 'maxInputReadMs', 'sendP95Ms', 'maxSendMs', 'incomingMs', 'projectedQueueMs', 'inputGapMs', 'pid', 'frames', 'packets', 'retransmitted', 'feedback', 'nacks', 'checkpoint', 'receiverDelayMs', 'targetDelayMs', 'encodeP50Ms', 'encodeP95Ms', 'encodeP99Ms', 'maxEncodeMs', 'feedbackAgeMs', 'sourceClockDifferenceMs', 'sourceClockOverrunMs', 'peak', 'queueMs', 'maxQueueMs', 'elapsedMs', 'readBlockMs', 'exitCode', 'bytes'];

export function diagnosticRecord(event, data = {}) {
  if (event === 'playback') {
    const record = { at: new Date().toISOString(), event };
    const integer = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
    if (!data || !integer(data.sequence, Number.MAX_SAFE_INTEGER) || !Array.isArray(data.media)) return null;
    record.sequence = data.sequence;
    if (['poll', 'error', 'stalled', 'waiting', 'emptied'].includes(data.trigger)) record.trigger = data.trigger;
    if (typeof data.hidden === 'boolean') record.hidden = data.hidden;
    if (integer(data.blockedFrames, 64)) record.blockedFrames = data.blockedFrames;
    if (integer(data.mediaCount, 64)) record.mediaCount = data.mediaCount;
    record.media = data.media.slice(0, 4).filter(m => m && integer(m.slot, Number.MAX_SAFE_INTEGER)).map(m => {
      const result = { slot: m.slot };
      if (typeof m.currentTime === 'number' && Number.isFinite(m.currentTime) && m.currentTime >= 0 && m.currentTime <= 86400) result.currentTime = m.currentTime;
      for (const key of ['paused', 'ended', 'seeking']) if (typeof m[key] === 'boolean') result[key] = m[key];
      for (const [key, max] of [['readyState', 4], ['networkState', 3], ['errorCode', 4]]) if (integer(m[key], max)) result[key] = m[key];
      return result;
    });
    return record;
  }
  if (!events.has(event)) return null;
  const record = { at: new Date().toISOString(), event };
  if (!data || typeof data !== 'object') return record;
  for (const key of numbers) if (typeof data[key] === 'number' && Number.isFinite(data[key])) record[key] = data[key];
  if (codes.has(data.code)) record.code = data.code;
  if (exceptions.has(data.exception)) record.exception = data.exception;
  if (socketStages.has(data.socketStage)) record.socketStage = data.socketStage;
  for (const key of ['socketErrorCode', 'nativeErrorCode']) if (Number.isInteger(data[key]) && data[key] >= -1 && data[key] <= 2147483647) record[key] = data[key];
  if (Number.isInteger(data.socketAttempt) && data.socketAttempt >= 1 && data.socketAttempt <= 3) record.socketAttempt = data.socketAttempt;
  if (captureStages.has(data.stage)) record.stage = data.stage;
  if (typeof data.hresult === 'string' && /^0x[\da-f]{8}$/i.test(data.hresult)) record.hresult = data.hresult.toLowerCase();
  for (const key of ['adaptive', 'expected']) if (typeof data[key] === 'boolean') record[key] = data[key];
  return record;
}

// Temporary local diagnostics: bounded files, no raw exceptions, configuration or audio.
export function createDiagnosticLog(file) {
  let writes = Promise.resolve(), queued = 0, dropped = 0;
  const log = (event, data) => {
    const record = diagnosticRecord(event, data);
    if (!record) return;
    if (queued >= 64) { dropped++; return; }
    const line = JSON.stringify(record) + '\n'; queued++;
    writes = writes.then(async () => {
      try {
        const size = await fs.promises.stat(file).then(info => info.size).catch(error => { if (error.code === 'ENOENT') return 0; throw error; });
        if (size + Buffer.byteLength(line) > 1024 * 1024) {
          await fs.promises.rm(file + '.1', { force: true });
          await fs.promises.rename(file, file + '.1');
        }
        await fs.promises.appendFile(file, line);
      } catch { /* Logging must not interrupt the audio path. */ }
      finally { queued--; }
    });
  };
  log.flush = () => writes;
  Object.defineProperty(log, 'dropped', { get: () => dropped });
  return log;
}

export function failureCode(message) {
  if (message === 'Erreur réseau de l’émetteur audio. Retour sur le PC.') return 'SOCKET_FAILURE';
  if (message === 'Le relais vers le PC est bloqué. Fermez puis rouvrez Cider.') return 'PC_RELAY_STALLED';
  if (message === 'L’émetteur audio ne consomme plus le son. Retour sur le PC.') return 'SENDER_INPUT_STALLED';
  if (message === 'Le flux audio est désynchronisé. Retour sur le PC.') return 'SOURCE_CLOCK_LIMIT';
  if (message === 'Le relais PC est saturé. Relancez Cider.') return 'PC_RELAY_SATURATED';
  if (message === 'Le relais vers le PC est interrompu. Relancez Cider.') return 'PC_RELAY_INTERRUPTED';
  if (message === 'Émetteur audio interrompu.') return 'SENDER_INTERRUPTED';
  if (message === 'Cider ne répond plus.') return 'CIDER_HEARTBEAT_TIMEOUT';
  if (message === 'File audio supérieure à 500 ms.') return 'INPUT_QUEUE_LIMIT';
  return message ? 'OTHER' : 'USER_STOP';
}

export function observeSenderErrors(helper, log, closing, failed) {
  let pending = '';
  helper.stderr.on('data', chunk => {
    pending += chunk.toString();
    if (pending.length > 8192) { pending = ''; log('sender_stderr_invalid'); return; }
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try {
        const record = diagnosticRecord('sender_diagnostic', JSON.parse(line));
        log('sender_diagnostic', record);
        if (!closing() && (record.code === 'SOCKET_FAILURE' || (record.code === 'EXCEPTION' && record.exception === 'SocketException'))) failed?.(record);
      }
      catch { log('sender_stderr_invalid'); }
    }
  });
  helper.on('close', code => log('sender_exit', { exitCode: code, expected: closing() }));
}
