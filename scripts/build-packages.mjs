import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), app=path.join(root,'service'), dist=path.join(root,'dist');
const version='1.0.0-rc.2';
if(fs.existsSync(dist))throw Error('Preserve the existing distribution before rebuilding.');
const companion=path.join(dist,`Cider-Cast-Service-${version}-Windows-x64`), plugin=path.join(dist,'marketplace-plugin');
function copy(from,to){fs.mkdirSync(path.dirname(to),{recursive:true});fs.cpSync(from,to,{recursive:true});}
for(const name of ['server.mjs','streaming.mjs','audio-bridge.mjs','audio-outputs.mjs','diagnostic-log.mjs','Gardien-Cider.ps1','Gerer-Service.ps1','Lancer-Gardien.js','native/capture.exe','sender/bin/Release/net10.0/Sender.dll','sender/bin/Release/net10.0/Sender.deps.json','sender/bin/Release/net10.0/Sender.runtimeconfig.json','sender/bin/Release/net10.0/Concentus.dll'])copy(path.join(app,'cider-marshall-streaming-lab',name),path.join(companion,'app/cider-marshall-streaming-lab',name));
for(const name of ['discover.mjs','package.json','package-lock.json','node_modules'])copy(path.join(app,'cider-marshall-isolated',name),path.join(companion,'app/cider-marshall-isolated',name));
copy(path.join(app,'runtime'),path.join(companion,'app/runtime'));
copy(path.join(root,'sources'),path.join(companion,'sources'));
copy(path.join(root,'licenses'),path.join(companion,'licenses'));
for(const name of ['Installer.ps1','Installer.js','Desinstaller.js','Retour-Version-Precedente.js','LIRE-MOI.md','THIRD-PARTY-NOTICES.md'])copy(path.join(root,name),path.join(companion,name));
copy(path.join(root,'LICENSE'),path.join(companion,'LICENSE'));
for(const name of ['plugin.yml','plugin.js','connection.js','release-info.js','output-control.js','audio-settings.js','native-volume.js','playback-diagnostic.js'])copy(path.join(root,'plugin',name),path.join(plugin,name));
copy(path.join(root,'LICENSE'),path.join(plugin,'LICENSE'));
fs.writeFileSync(path.join(plugin,'README.md'),'# Cider Cast\n\nPlugin pour Cider 4, Windows 11 x64. Installez le service Windows depuis Sortie audio lors du premier lancement.\n\nhttps://github.com/LazzyPurple/Cider-Cast\n');
function inventory(directory){const files=[];for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isSymbolicLink())throw Error('No release symlinks.');if(entry.isDirectory())files.push(...inventory(file));else files.push(file);}return files;}
const forbidden=/^(?:config\.json|service-connection\.json|audio-output\.json|route-restore\.txt)$|\.(?:jsonl|log|pdb)$/;
for(const folder of [companion,plugin])for(const file of inventory(folder))if(forbidden.test(path.basename(file)))throw Error('Private file in release: '+file);
const manifest={name:'Cider Cast Windows Service',version,kind:'windows-companion',files:inventory(companion).map(file=>({path:path.relative(companion,file).replaceAll('\\','/'),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}))};
fs.writeFileSync(path.join(companion,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const zipCode='import pathlib,sys,zipfile\np=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED,compresslevel=6) as z:\n for f in sorted(p.rglob("*")):\n  if f.is_file(): z.write(f,f.relative_to(p).as_posix())\n';
for(const [folder,name] of [[companion,`Cider-Cast-Service-${version}-Windows-x64.zip`],[plugin,`Cider-Cast-${version}.zip`]]){const result=spawnSync('python',['-c',zipCode,folder,path.join(dist,name)],{encoding:'utf8',windowsHide:true});if(result.status!==0)throw Error(result.stderr);}
console.log(JSON.stringify({version,companionFiles:manifest.files.length,marketplaceFiles:inventory(plugin).length,privateConnectionIncluded:false,dist},null,2));
