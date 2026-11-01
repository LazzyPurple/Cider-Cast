import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createAudioBridge } from './audio-bridge.mjs';

test('vrai FFplay : deux retours PC de silence synthétique sans saturation', { timeout: 10000 }, async () => {
  const config = { playerPath: process.env.CIDER_CAST_FFPLAY };
  assert.ok(config.playerPath && fs.existsSync(config.playerPath), 'Set CIDER_CAST_FFPLAY to the installed ffplay.exe for the real-player smoke test.');
  const native = new EventEmitter(); native.stdin = new PassThrough(); native.stdout = new PassThrough(); native.stderr = new PassThrough();
  native.stdin.on('finish', () => { native.emit('exit', 0); native.emit('close', 0); });
  const players = [], errors = [];
  const bridge = createAudioBridge(config, { audio() {}, error(message) { errors.push(message); }, closed() {} }, (exe, args, options) => {
    if (exe.endsWith('capture.exe')) return native;
    const p = spawn(exe, args, options); players.push(p); return p;
  });
  let maximum = 0;
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let frame = 0; frame < 75; frame++) {
        native.stdout.write(Buffer.alloc(7680));
        maximum = Math.max(maximum, players.at(-1).stdin.writableLength);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      bridge.setLocal(false); bridge.setLocal(true);
    }
    assert.deepEqual(errors, []); assert.ok(maximum < 384000, 'PCM queue stayed bounded');
  } finally { await bridge.close(); await Promise.all(players.map(p => p.exitCode === null && !p.signalCode ? once(p, 'exit') : null)); }
});
