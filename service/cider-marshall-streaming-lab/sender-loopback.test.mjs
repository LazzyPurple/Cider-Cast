import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes, createDecipheriv } from 'node:crypto';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Streaming } from './streaming.mjs';
import { createAudioBridge } from './audio-bridge.mjs';

for (const mode of ['normal', 'gap', 'recover', 'burst', 'late', 'no-feedback']) test(`émetteur réel : Opus, retransmission et source ${mode}`, { timeout: 15000 }, async () => {
  const gapMs = mode === 'gap' ? 120 : mode === 'late' ? 700 : mode === 'recover' ? 470 : 0;
  const frameCount = mode === 'late' ? 200 : mode === 'no-feedback' ? 250 : 100;
  const peer = dgram.createSocket('udp4'); peer.bind(0, '127.0.0.1'); await once(peer, 'listening');
  const child = spawn(fileURLToPath(new URL('../runtime/dotnet/dotnet.exe', import.meta.url)), [fileURLToPath(new URL('./sender/bin/Release/net10.0/Sender.dll', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const ended = once(child, 'exit'); child.stdin.on('error', () => {});
  const key = randomBytes(16), iv = randomBytes(16); let logs = '', errors = '', packets = 0, reports = 0, retransmitted = 0;
  child.stdout.on('data', d => logs += d); child.stderr.on('data', d => errors += d);
  const config = Buffer.from(JSON.stringify({ Host: '127.0.0.1', Port: peer.address().port, Ssrc: 42, Key: key.toString('hex'), Iv: iv.toString('hex'), DelayMs: 400, Adaptive: false, PayloadType: 96 }));
  const size = Buffer.alloc(4); size.writeUInt32LE(config.length); child.stdin.write(Buffer.concat([size, config]));
  const seen = new Map(); let wireError;
  peer.on('message', (data, sender) => {
    try {
      if (data[1] === 200) { reports++; assert.equal(data.readUInt32BE(4), 42); return; }
      packets++; assert.equal(data[1], 224); assert.equal(data.readUInt32BE(8), 42);
      const frame = data[13], header = data[12] & 1 ? 23 : 19;
      if (seen.has(frame)) { assert.deepEqual(data, seen.get(frame)); retransmitted++; } else seen.set(frame, Buffer.from(data));
      const nonce = Buffer.from(iv); const f = Buffer.alloc(4); f.writeUInt32BE(frame); for (let i = 0; i < 4; i++) nonce[i + 8] ^= f[i];
      const decoder = createDecipheriv('aes-128-ctr', key, nonce); const opus = Buffer.concat([decoder.update(data.subarray(header)), decoder.final()]);
      assert.equal(opus.length, 320); assert.equal(data.readUInt32BE(4), frame * 960);
      if (mode === 'no-feedback') return;
      const nack = frame === 2 && retransmitted === 0;
      const feedback = Buffer.alloc(nack ? 24 : 20); feedback[0] = 0x8f; feedback[1] = 206;
      feedback.writeUInt16BE(feedback.length / 4 - 1, 2); feedback.writeUInt32BE(43, 4); feedback.writeUInt32BE(42, 8); feedback.write('CAST', 12);
      feedback[16] = frame; feedback[17] = nack ? 1 : 0; feedback.writeUInt16BE(400, 18);
      if (nack) { feedback[20] = 1; feedback.writeUInt16BE(0, 21); }
      peer.send(feedback, sender.port, sender.address);
    } catch (e) { wireError = e; }
  });
  let bridge, forwarded = 0, maximum = 0;
  const flowErrors = [];
  const native = new EventEmitter(); native.stdin = new PassThrough(); native.stdout = new PassThrough(); native.stderr = new PassThrough();
  const transport = Object.assign(Object.create(Streaming.prototype), { ready: true, helper: child, pending: new Set(), hooks: { drain: () => bridge.resume(), error: message => flowErrors.push(message) } });
  if (mode === 'burst') {
    bridge = createAudioBridge({ ffmpeg: process.execPath, endpointId: 'test' }, {
      audio(data) { forwarded += data.length; const writable = transport.write(data); maximum = Math.max(maximum, child.stdin.writableLength); return writable; },
      error: message => flowErrors.push(message), closed() {},
    }, exe => {
      if (exe.endsWith('capture.exe')) return native;
      const player = new EventEmitter(); player.stdin = new PassThrough(); player.stderr = new PassThrough(); player.kill = () => {}; return player;
    });
    bridge.setLocal(false);
  }
  try {
    for (let i = 0; i < 100 && !logs.includes('ready'); i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(logs.includes('ready'), errors);
    const start = performance.now();
    for (let frame = 0; frame < frameCount; frame++) {
      if (frame === 60 && gapMs) await new Promise(r => setTimeout(r, gapMs));
      const pcm = Buffer.alloc(7680);
      for (let sample = 0; sample < 960; sample++) { const value = Math.sin((frame * 960 + sample) * Math.PI * 880 / 48000) * .015; pcm.writeFloatLE(value, sample * 8); pcm.writeFloatLE(value, sample * 8 + 4); }
      if (bridge) native.stdout.write(pcm);
      else { child.stdin.write(pcm); await new Promise(r => setTimeout(r, Math.max(0, start + (frame + 1) * (mode === 'no-feedback' ? 25 : 20) + (frame >= 60 && mode !== 'recover' ? gapMs : 0) - performance.now()))); }
    }
    if (bridge) {
      for (let i = 0; i < 200 && forwarded < 100 * 7680 && !logs.includes('failure'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    }
    child.stdin.end(); const [code] = await ended;
    if (wireError) throw wireError;
    if (mode === 'no-feedback') {
      assert.equal(code, 1); assert.match(errors, /FEEDBACK_TIMEOUT/);
      const failure = errors.trim().split('\n').map(JSON.parse).find(x => x.code === 'FEEDBACK_TIMEOUT');
      assert.ok(failure.feedbackAgeMs > 5000); assert.ok(seen.size > 0);
      return;
    }
    assert.equal(code, 0, errors);
    assert.deepEqual([...seen.keys()], Array.from({ length: frameCount }, (_, i) => i));
    assert.ok(packets >= frameCount + 1 && reports >= frameCount / 10 && retransmitted >= 1);
    const stats = logs.trim().split('\n').map(line => JSON.parse(line)).filter(x => x.type === 'stats').at(-1);
    assert.equal(stats.frames, frameCount); assert.ok(stats.feedback > (bridge ? 0 : 50) && stats.retransmitted >= 1); assert.equal(stats.receiverDelayMs, 400);
    assert.ok(Number.isFinite(stats.inputReadP95Ms) && Number.isFinite(stats.maxSendMs));
    if (mode === 'gap') assert.ok(stats.sourceClockDifferenceMs > 50 && stats.sourceClockDifferenceMs < 400);
    if (mode === 'recover') assert.ok(Math.abs(stats.sourceClockDifferenceMs) < 200);
    if (mode === 'late') assert.ok(stats.sourceClockDifferenceMs > 500);
    if (mode === 'burst') {
      assert.equal(forwarded, frameCount * 7680); assert.deepEqual(flowErrors, []);
      assert.ok(maximum <= 192000); assert.ok(stats.sourceClockDifferenceMs < -400);
    }
  } finally {
    if (bridge) { const closed = bridge.close(); native.emit('close', 0); await closed; }
    clearTimeout(transport.queueTimer); child.kill(); peer.close();
  }
});
