import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), dist=path.join(root,'dist');
const setup=path.join(dist,'Cider-Cast-Service-1.0.0-rc.2-Windows-x64.exe');
test('ZIP Marketplace : manifeste et modules a la racine, sans secret ni executable', async () => {
  const archive=path.join(dist,'local.marshall-cast-1.0.0-rc.2.zip');
  const listing=spawnSync('python',['-c','import sys,json,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',archive],{encoding:'utf8',windowsHide:true});
  assert.equal(listing.status,0,listing.stderr);const names=JSON.parse(listing.stdout);
  assert.ok(names.includes('plugin.yml')&&names.includes('plugin.js')&&names.includes('connection.js'));
  assert.ok(names.every(n=>!n.includes('/')&&!/\.(exe|dll|ps1|jsonl|log)$/.test(n)));
  assert.ok(!names.includes('service-connection.json'));
  globalThis.HTMLElement=class{};
  const {default:plugin}=await import(pathToFileURL(path.join(dist,'marketplace-plugin/plugin.js')));
  assert.equal(plugin.name,'Cider Cast');assert.equal(plugin.author,'LazzyPurple');assert.equal(plugin.repo,'https://github.com/LazzyPurple/Cider-Cast');assert.equal(plugin.version,'1.0.0-rc.2');assert.equal(typeof plugin.setup,'function');
  const {release}=await import(pathToFileURL(path.join(dist,'marketplace-plugin/release-info.js')));
  assert.equal(release.installerUrl,plugin.repo+'/releases/download/v'+plugin.version+'/Cider-Cast-Service-'+plugin.version+'-Windows-x64.exe');
});
test('installateur EXE : arguments Windows et ressource verifiee sans installation', () => {
  const result=spawnSync(setup,['--self-test'],{windowsHide:true,timeout:10000});assert.equal(result.status,0);
});
test('installateur EXE : vraie extraction du paquet et empreintes, aucun service lance', {timeout:60000}, () => {
  const result=spawnSync(setup,['--extract-only'],{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(result.status,0,result.stderr);
  const folder=result.stdout.trim(), parent=path.dirname(folder);
  assert.equal(path.basename(folder),'package');assert.equal(path.dirname(parent).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());assert.match(path.basename(parent),/^CiderCastSetup-\{[a-f0-9-]+\}$/i);
  try {
    const manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8'));
    for(const entry of manifest.files){const file=path.resolve(folder,entry.path);assert.ok(file.startsWith(folder+path.sep));assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),entry.sha256);}
    assert.equal(manifest.kind,'windows-companion');assert.ok(!fs.existsSync(path.join(folder,'app/cider-marshall-isolated/config.json')));assert.ok(!fs.existsSync(path.join(folder,'app/cider-marshall-isolated/plugin')));
  }finally{fs.rmSync(parent,{recursive:true});}
});
