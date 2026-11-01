import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const endpointId = value => typeof value === 'string' && /^\{0\.0\.0\.00000000\}\.\{[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\}$/i.test(value);
export function createOutputSettings(capturePath, file, run = promisify(execFile)) {
  function load() {
    try {
      if (fs.statSync(file).size > 1024) throw Error('invalid');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!saved || Object.keys(saved).length !== 1 || !endpointId(saved.endpointId)) throw Error('invalid');
      return saved.endpointId;
    } catch (error) { if (error.code === 'ENOENT') return null; throw Error('Le réglage de sortie Windows est invalide.'); }
  }
  async function list(preferred) {
    let stdout;
    try { ({ stdout } = await run(capturePath, [preferred ?? '', '--outputs'], { windowsHide: true, timeout: 3000, maxBuffer: 65536, encoding: 'utf8' })); }
    catch { throw Error('Impossible de lire les sorties Windows. Réessayez.'); }
    let outputs;
    try { outputs = JSON.parse(stdout); } catch { throw Error('Réponse des sorties Windows invalide.'); }
    if (!Array.isArray(outputs) || outputs.length > 64 || outputs.some(o => !o || !endpointId(o.id) || typeof o.name !== 'string' || !o.name.length || o.name.length > 512 || ['isDefault', 'inUse', 'selected'].some(k => typeof o[k] !== 'boolean')) || new Set(outputs.map(o => o.id)).size !== outputs.length) throw Error('Réponse des sorties Windows invalide.');
    return outputs.map(({ id, name, isDefault, inUse, selected }) => ({ id, name, isDefault, inUse, selected }));
  }
  async function save(id, preferred) {
    if (!endpointId(id)) throw Error('Sortie Windows invalide.');
    const chosen = (await list(preferred)).find(o => o.id === id);
    if (!chosen) throw Error('Cette sortie Windows est indisponible.');
    if (chosen.isDefault) throw Error('Choisissez une sortie différente de la sortie Windows par défaut.');
    if (chosen.inUse) throw Error('Cette sortie est utilisée. Arrêtez sa lecture avant de la réserver.');
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.promises.writeFile(temporary, JSON.stringify({ endpointId: id }) + '\n', { flag: 'wx' });
      await fs.promises.rename(temporary, file);
    } finally { await fs.promises.rm(temporary, { force: true }); }
    return id;
  }
  return { load, list, save };
}
