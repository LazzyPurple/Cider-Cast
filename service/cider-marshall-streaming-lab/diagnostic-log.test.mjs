import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDiagnosticLog, diagnosticRecord, observeSenderErrors, failureCode } from './diagnostic-log.mjs';

test('socket : codes et étape conservés, reprise non fatale et cause transmise avant fermeture du pipe', () => {
  const helper = new EventEmitter(); helper.stderr = new PassThrough();
  const entries = [], failures = [];
  observeSenderErrors(helper, (event, data) => entries.push(diagnosticRecord(event, data)), () => false, data => failures.push(data));
  helper.stderr.write('{"code":"SOCKET_RETRY","exception":"SocketException","socketErrorCode":10055,"nativeErrorCode":10055,"socketAttempt":1,"socketStage":"send-audio","message":"secret"}\n');
  helper.stderr.write('{"code":"SOCKET_RETRANSMIT_FAILED","socketStage":"retransmit"}\n');
  assert.equal(failures.length, 0);
  helper.stderr.write('{"code":"SOCKET_FAILURE","exception":"SocketException","socketErrorCode":10051,"nativeErrorCode":10051,"socketAttempt":1,"socketStage":"send-');
  helper.stderr.write('report","message":"secret"}\n');
  assert.equal(failures.length, 1); assert.equal(failures[0].socketStage, 'send-report');
  assert.equal(entries[0].socketErrorCode, 10055); assert.equal(entries[0].nativeErrorCode, 10055); assert.equal(entries[0].socketAttempt, 1);
  assert.ok(!JSON.stringify({ entries, failures }).includes('secret'));
  assert.equal(failureCode('Erreur réseau de l’émetteur audio. Retour sur le PC.'), 'SOCKET_FAILURE');
  const invalid = diagnosticRecord('sender_diagnostic', { socketErrorCode: NaN, nativeErrorCode: 1.5, socketAttempt: 4, socketStage: 'secret' });
  assert.ok(!('socketErrorCode' in invalid) && !('nativeErrorCode' in invalid) && !('socketAttempt' in invalid) && !('socketStage' in invalid));
  const closing = new EventEmitter(); closing.stderr = new PassThrough(); let failuresAfterClose = 0;
  observeSenderErrors(closing, () => {}, () => true, () => failuresAfterClose++);
  closing.stderr.write('{"code":"SOCKET_FAILURE"}\n');
  assert.equal(failuresAfterClose, 0);
});

test('capture : temporisation numérique conservée sans texte libre ni donnée privée', () => {
  const record = diagnosticRecord('capture_timing', { maxPacketGapMs: 700, maxPacketAgeMs: 20, qpcPackets: 100, mmcssActive: 1, token: 'secret', message: 'secret' });
  assert.equal(record.maxPacketGapMs, 700); assert.equal(record.mmcssActive, 1);
  assert.ok(!JSON.stringify(record).includes('secret'));
  assert.ok(!('maxPacketAgeMs' in diagnosticRecord('capture_timing', { maxPacketAgeMs: Infinity })));
});

test('horloge : durée du dépassement numérique conservée, valeurs invalides exclues', () => {
  assert.equal(diagnosticRecord('sender_diagnostic', { sourceClockOverrunMs: 500 }).sourceClockOverrunMs, 500);
  assert.ok(!('sourceClockOverrunMs' in diagnosticRecord('stats', { sourceClockOverrunMs: NaN })));
});

test('diagnostic lecteur : ne conserve que les états numériques et booléens autorisés', () => {
  const entry = diagnosticRecord('playback', { sequence: 1, trigger: 'error', hidden: false, blockedFrames: 1,
    token: 'secret', media: [{ slot: 1, currentTime: .2, paused: false, readyState: 2, networkState: 2, errorCode: 3, src: 'secret', message: 'secret' }] });
  assert.equal(entry.media[0].errorCode, 3); assert.equal(entry.media[0].currentTime, .2);
  assert.ok(!JSON.stringify(entry).includes('secret'));
  assert.equal(diagnosticRecord('playback', null), null);
  const invalid = diagnosticRecord('playback', { sequence: 2, trigger: 'secret', blockedFrames: Infinity,
    media: [{ slot: 1, currentTime: NaN, paused: 'secret', readyState: 5, networkState: -1, errorCode: 42 }, { slot: 'secret' }] });
  assert.deepEqual(invalid.media, [{ slot: 1 }]); assert.ok(!('trigger' in invalid));
  assert.equal(diagnosticRecord('playback', { sequence: 3, media: Array(10).fill({ slot: 1 }) }).media.length, 4);
});

test('diagnostic : liste autorisée, rotation et panne disque sans arrêt audio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marshall-log-test-'));
  const file = path.join(dir, 'events.jsonl');
  try {
    const log = createDiagnosticLog(file);
    const secret = 'private-key-or-token';
    log('stats', { frames: 50, peak: .1, queueMs: Infinity, token: secret, Key: secret, message: secret, host: secret, code: secret, exception: secret });
    await log.flush();
    const data = fs.readFileSync(file, 'utf8');
    assert.ok(!data.includes(secret));
    assert.deepEqual(Object.keys(JSON.parse(data)), ['at', 'event', 'frames', 'peak']);
    assert.equal(diagnosticRecord(secret, {}), null);
    assert.equal(diagnosticRecord('stats', null).event, 'stats');
    const captured = diagnosticRecord('capture_error', { hresult: '0x80070490', stage: 'selection', token: secret });
    assert.equal(captured.hresult, '0x80070490'); assert.equal(captured.stage, 'selection');
    assert.ok(!JSON.stringify(captured).includes(secret));
    assert.ok(!('stage' in diagnosticRecord('capture_error', { stage: secret })));
    fs.writeFileSync(file, 'x'.repeat(1024 * 1024));
    log('sender_exit', { exitCode: 1, expected: false });
    await log.flush();
    assert.equal(fs.statSync(file + '.1').size, 1024 * 1024);
    assert.equal(JSON.parse(fs.readFileSync(file)).exitCode, 1);
    const broken = createDiagnosticLog(dir); broken('stats', { frames: 1 }); await broken.flush();
  } finally {
    fs.rmSync(file, { force: true }); fs.rmSync(file + '.1', { force: true }); fs.rmdirSync(dir);
  }
});

test('journal saturé : file de diagnostics bornée et disque lent sans bloquer la lecture', async t => {
  let release, calls = 0;
  const gate = new Promise(resolve => release = resolve);
  t.mock.method(fs.promises, 'stat', async () => ({ size: 0 }));
  t.mock.method(fs.promises, 'appendFile', async () => { calls++; await gate; });
  const log = createDiagnosticLog('test-only');
  for (let i = 0; i < 1000; i++) log('stats', { frames: i });
  assert.equal(log.dropped, 936);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  release(); await log.flush(); assert.equal(calls, 64);
  assert.deepEqual(diagnosticRecord('capture_stats', { capturedFrames: 48000, missingFrames: 480, token: 'secret' }).missingFrames, 480);
  assert.equal(diagnosticRecord('sender_input_stalled', { elapsedMs: 518, queueMs: 171 }).elapsedMs, 518);
});

test('diagnostic : stderr fragmenté et conservé après une erreur du canal entrée', () => {
  const helper = new EventEmitter(); helper.stderr = new PassThrough();
  const entries = [];
  observeSenderErrors(helper, (event, data) => entries.push(diagnosticRecord(event, data)), () => false);
  helper.stdin = new EventEmitter(); helper.stdin.on('error', () => {});
  helper.stdin.emit('error', new Error('pipe closed'));
  helper.stderr.write('{"code":"SOURCE_CLOCK_');
  helper.stderr.write('LIMIT","frames":60,"message":"secret"}\n');
  helper.stderr.write('secret raw stderr\n');
  helper.stderr.write('x'.repeat(9000));
  helper.emit('close', 1);
  assert.equal(entries[0].code, 'SOURCE_CLOCK_LIMIT');
  assert.equal(entries[0].frames, 60);
  assert.equal(entries[1].event, 'sender_stderr_invalid');
  assert.equal(entries[2].event, 'sender_stderr_invalid');
  assert.equal(entries[3].exitCode, 1);
  assert.equal(entries[3].expected, false);
  assert.ok(!JSON.stringify(entries).includes('secret'));
});
