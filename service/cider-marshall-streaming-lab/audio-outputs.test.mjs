import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOutputSettings } from './audio-outputs.mjs';
const id = '{0.0.0.00000000}.{11111111-1111-1111-1111-111111111111}';
const other = '{0.0.0.00000000}.{22222222-2222-2222-2222-222222222222}';
test('sortie réservée : validation, sauvegarde atomique, relecture et refus sans modification', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-output-')); const file = path.join(dir, 'audio-output.json');
  let outputs = [{ id, name: 'Écran "USB"', isDefault: false, inUse: false, selected: false }]; const calls = [];
  const settings = createOutputSettings('capture.exe', file, async (...args) => { calls.push(args); return { stdout: JSON.stringify(outputs) }; });
  try {
    assert.equal(settings.load(), null);
    assert.equal(await settings.save(id, other), id); assert.equal(settings.load(), id);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { endpointId: id });
    assert.deepEqual(calls[0][1], [other, '--outputs']); assert.equal(calls[0][2].windowsHide, true);
    const before = fs.readFileSync(file, 'utf8');
    for (const flags of [{ isDefault: true }, { inUse: true }]) {
      outputs = [{ ...outputs[0], isDefault: false, inUse: false, ...flags }];
      await assert.rejects(settings.save(id, other)); assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
    await assert.rejects(settings.save('injected\n--restore', other), /invalide/);
    await assert.rejects(settings.save(other, id), /indisponible/);
    for (const invalid of [{ endpointId: 'bad' }, { endpointId: id, token: 'not-allowed' }]) {
      fs.writeFileSync(file, JSON.stringify(invalid)); assert.throws(() => settings.load(), /invalide/);
    }
    assert.deepEqual(fs.readdirSync(dir), ['audio-output.json']);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('énumération bornée, erreurs natives et données inattendues refusées', async () => {
  let args;
  assert.deepEqual(await createOutputSettings('capture', 'unused', async (...values) => { args = values; return { stdout: '[]' }; }).list(), []);
  assert.deepEqual(args[1], ['', '--outputs']);
  for (const stdout of ['bad-json', '{}', JSON.stringify([{ id, name: '<unsafe>', isDefault: false }]), JSON.stringify(Array(65).fill({})), JSON.stringify([{ id, name: 'A', isDefault: false, inUse: false, selected: true },{ id, name: 'B', isDefault: false, inUse: false, selected: true }])]) {
    const settings = createOutputSettings('capture', 'unused', async () => ({ stdout })); await assert.rejects(settings.list(id), /invalide/);
  }
  await assert.rejects(createOutputSettings('capture', 'unused', async () => { throw Error('native details'); }).list(id), /Impossible de lire/);
});
