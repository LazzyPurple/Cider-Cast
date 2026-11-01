import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = path.join(here,'dist/Cider-Cast-Service-1.0.0-rc.2-Windows-x64/Installer.ps1');
const harness = String.raw`
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -Force
function Get-AppxPackage { param($Name) [pscustomobject]@{Version='4.0.32.0'} }
function Get-Process { param($Name) if($env:CAST_TEST_OPEN -eq '1'){[pscustomobject]@{Id=123}} }
function Get-CimInstance {
 param($ClassName,$Filter)
 if($env:CAST_TEST_DETACHED -eq '1' -and -not (Test-Path -LiteralPath ($env:CAST_TEST_TASK+'.stopped'))) {
  $guardian=Join-Path $env:LOCALAPPDATA 'CiderCast/app/cider-marshall-streaming-lab/Gardien-Cider.ps1'
  [pscustomobject]@{Name='powershell.exe';ProcessId=99999999;CommandLine=('powershell.exe -File "'+$guardian+'"')}
  [pscustomobject]@{Name='pwsh.exe';ProcessId=88888888;CommandLine=('pwsh.exe -Command "echo '+$guardian+'"')}
 }
}
function Stop-Process { param($Id) if($Id -ne 99999999){throw 'Unrelated process selected'};[IO.File]::WriteAllText(($env:CAST_TEST_TASK+'.stopped'),'owned guardian stopped') }
function Get-NetTCPConnection { param($LocalPort,$State) }
function Invoke-RestMethod { throw 'The fixture must not contact a live service.' }
function Get-Command {
 param($Name)
 if($Name -eq 'ffplay.exe'){[pscustomobject]@{Source=$env:CAST_TEST_PLAYER}}
 elseif($Name -eq 'winget.exe'){}
 else{Microsoft.PowerShell.Core\Get-Command $Name -ErrorAction Stop}
}
function Get-ScheduledTask { param($TaskName) if(Test-Path -LiteralPath $env:CAST_TEST_TASK){Get-Content -LiteralPath $env:CAST_TEST_TASK -Raw|ConvertFrom-Json} }
function Stop-ScheduledTask { param($TaskName) }
function Start-ScheduledTask { param($TaskName) }
function Unregister-ScheduledTask { param($TaskName,[switch]$Confirm) Remove-Item -LiteralPath $env:CAST_TEST_TASK -ErrorAction SilentlyContinue }
function Export-ScheduledTask { param($TaskName) '<MockTask>'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Content -LiteralPath $env:CAST_TEST_TASK -Raw)))+'</MockTask>' }
function New-ScheduledTaskAction {param($Execute,$Argument,$WorkingDirectory) [pscustomobject]@{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory} }
function New-ScheduledTaskTrigger {param([switch]$AtLogOn,$User,[switch]$Once,$At,$RepetitionInterval) [pscustomobject]@{Kind='fixture'} }
function New-ScheduledTaskPrincipal {param($UserId,$LogonType,$RunLevel) [pscustomobject]@{Kind='fixture'} }
function New-ScheduledTaskSettingsSet {param([switch]$Hidden,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,[switch]$StartWhenAvailable,$ExecutionTimeLimit,$MultipleInstances) [pscustomobject]@{Priority=0} }
function Register-ScheduledTask {
 param($TaskName,$Action,$Trigger,$Principal,$Settings,$Description,[switch]$Force,[string]$Xml)
 if($Xml){$text=([xml]$Xml).MockTask;[IO.File]::WriteAllText($env:CAST_TEST_TASK,[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($text)));return}
 if($env:CAST_TEST_FAIL_SERVICE -eq '1'){throw 'TEST_SERVICE_FAILURE'}
 [IO.File]::WriteAllText($env:CAST_TEST_TASK,([pscustomobject]@{Actions=@($Action)}|ConvertTo-Json -Depth 8))
}
& $env:CAST_TEST_INSTALLER -Action $env:CAST_TEST_ACTION
if($LASTEXITCODE){exit $LASTEXITCODE}
`;
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cider-cast-installer-'));
  fs.mkdirSync(path.join(root,'temp'));
  fs.mkdirSync(path.join(root,'local/Packages/CiderCollective.Cider_a6qxe093bx5xj/LocalCache/Roaming/sh.cider.dotnet'),{recursive:true});
  const plugin=path.join(root,'local/Packages/CiderCollective.Cider_a6qxe093bx5xj/LocalCache/Roaming/sh.cider.dotnet/plugins/local.marshall-cast');
  fs.mkdirSync(plugin,{recursive:true});
  for(const name of ['plugin.yml','plugin.js','connection.js'])fs.copyFileSync(path.join(here,'plugin',name),path.join(plugin,name));
  fs.writeFileSync(path.join(plugin,'marketplace-owned.txt'),'preserve Marketplace files');
  const player=path.join(root,'ffplay.exe'); fs.writeFileSync(player,'fixture; never executed');
  const script=path.join(root,'harness.ps1'); fs.writeFileSync(script,harness);
  const run=(action,extra={})=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,encoding:'utf8',timeout:120000,env:{...process.env,LOCALAPPDATA:path.join(root,'local'),TEMP:path.join(root,'temp'),CAST_TEST_INSTALLER:installer,CAST_TEST_ACTION:action,CAST_TEST_PLAYER:player,CAST_TEST_TASK:path.join(root,'task.json'),...extra}});
  return {root,run,app:path.join(root,'local/CiderCast/app'),plugin:path.join(root,'local/Packages/CiderCollective.Cider_a6qxe093bx5xj/LocalCache/Roaming/sh.cider.dotnet/plugins/local.marshall-cast'),cleanup(){assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('cider-cast-installer-'));fs.rmSync(root,{recursive:true});}};
}
test('installation simulée : jeton neuf, aucune sortie prédéfinie, mise à jour, retour arrière et retrait', {timeout:120000}, () => {
  const f=fixture();
  try {
    let result=f.run('Install'); assert.equal(result.status,0,result.stderr+result.stdout);
    const configFile=path.join(f.app,'cider-marshall-isolated/config.json'), config=JSON.parse(fs.readFileSync(configFile,'utf8'));
    assert.match(config.token,/^[a-f0-9]{64}$/); assert.equal(config.endpointId,''); assert.equal(config.target,'');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.plugin,'service-connection.json'),'utf8')).token,config.token);
    assert.ok(!fs.readFileSync(path.join(f.plugin,'connection.js'),'utf8').includes(config.token));
    const outputFile=path.join(f.app,'cider-marshall-streaming-lab/audio-output.json');
    fs.writeFileSync(outputFile,JSON.stringify({endpointId:'{0.0.0.00000000}.{11111111-1111-1111-1111-111111111111}'}));
    const server=path.join(f.app,'cider-marshall-streaming-lab/server.mjs');fs.appendFileSync(server,'\n// previous-version-sentinel\n');
    result=f.run('Install');assert.equal(result.status,0,result.stderr+result.stdout);
    assert.equal(JSON.parse(fs.readFileSync(configFile,'utf8')).token,config.token);
    assert.ok(fs.existsSync(outputFile)); assert.ok(!fs.readFileSync(server,'utf8').includes('previous-version-sentinel'));
    result=f.run('Restore');assert.equal(result.status,0,result.stderr+result.stdout);
    assert.ok(fs.readFileSync(server,'utf8').includes('previous-version-sentinel'));
    assert.equal(JSON.parse(fs.readFileSync(configFile,'utf8')).token,config.token);
    result=f.run('Remove');assert.equal(result.status,0,result.stderr+result.stdout);
    assert.equal(fs.existsSync(path.join(f.plugin,'marketplace-owned.txt')),true);assert.equal(fs.existsSync(path.join(f.plugin,'service-connection.json')),false);assert.equal(fs.existsSync(path.join(f.root,'task.json')),false);
    assert.ok(fs.existsSync(configFile));
  } finally {f.cleanup();}
});
test('paquet altéré ou chemin sortant : refus avant toute installation', () => {
  const f=fixture();
  try {
    const bad=path.join(f.root,'bad-package');fs.mkdirSync(bad);const script=path.join(bad,'Installer.ps1');fs.copyFileSync(installer,script);
    const outside=path.join(f.root,'escape.txt');fs.writeFileSync(outside,'preserve-me');
    for(const entry of [{path:'../escape.txt',sha256:'0'.repeat(64)},{path:'payload.bin',sha256:'0'.repeat(64)}]){
      fs.writeFileSync(path.join(bad,'payload.bin'),'modified');fs.writeFileSync(path.join(bad,'manifest.json'),JSON.stringify({version:'1.0.0-rc.2',files:[entry]}));
      const result=f.run('Check',{CAST_TEST_INSTALLER:script});assert.equal(result.status,1);assert.equal(fs.existsSync(f.app),false);assert.equal(fs.readFileSync(outside,'utf8'),'preserve-me');
    }
  }finally{f.cleanup();}
});
test('échec d’activation simulé : programme, connexion et tâche précédents conservés', {timeout:120000}, () => {
  const f=fixture();
  try {
    let result=f.run('Install');assert.equal(result.status,0,result.stderr+result.stdout);
    const server=path.join(f.app,'cider-marshall-streaming-lab/server.mjs');fs.appendFileSync(server,'\n// rollback-sentinel\n');
    const token=JSON.parse(fs.readFileSync(path.join(f.app,'cider-marshall-isolated/config.json'),'utf8')).token;
    result=f.run('Install',{CAST_TEST_FAIL_SERVICE:'1'});assert.equal(result.status,1);
    assert.ok(fs.readFileSync(server,'utf8').includes('rollback-sentinel'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.plugin,'service-connection.json'),'utf8')).token,token);
    assert.ok(fs.existsSync(path.join(f.root,'task.json')));assert.ok(!result.stderr.includes(token));
  } finally {f.cleanup();}
});
test('Cider ouvert et journal en attente : refus avant remplacement', {timeout:120000}, () => {
  const f=fixture();
  try {
    let result=f.run('Install',{CAST_TEST_OPEN:'1'});assert.equal(result.status,1);assert.equal(fs.existsSync(f.app),false);
    result=f.run('Install');assert.equal(result.status,0,result.stderr+result.stdout);
    const journal=path.join(f.app,'cider-marshall-isolated/native/route-restore.txt');fs.writeFileSync(journal,'fixture journal; never read by audio APIs');
    const before=fs.readFileSync(path.join(f.plugin,'plugin.js'),'utf8');
    result=f.run('Install');assert.equal(result.status,1);assert.equal(fs.readFileSync(journal,'utf8'),'fixture journal; never read by audio APIs');
    assert.equal(fs.readFileSync(path.join(f.plugin,'plugin.js'),'utf8'),before);
  } finally {f.cleanup();}
});

test('plugin Marketplace manquant ou version differente : refus avant preparation du service', () => {
  const f=fixture();
  try {
    fs.unlinkSync(path.join(f.plugin,'plugin.yml'));
    let result=f.run('Install');assert.equal(result.status,1);assert.equal(fs.existsSync(f.app),false);assert.match(result.stderr,/plugin Cider Cast/);
    fs.writeFileSync(path.join(f.plugin,'plugin.yml'),'identifier: local.marshall-cast\nversion: 0.8.0\n');
    result=f.run('Install');assert.equal(result.status,1);assert.equal(fs.existsSync(f.app),false);assert.match(result.stderr,/1\.0\.0-rc\.2/);
  }finally{f.cleanup();}
});

test('mise a jour : seul le gardien detache exact est termine, jamais un processus voisin', {timeout:120000}, () => {
  const f=fixture();
  try {
    let result=f.run('Install');assert.equal(result.status,0,result.stderr+result.stdout);
    result=f.run('Install',{CAST_TEST_DETACHED:'1'});assert.equal(result.status,0,result.stderr+result.stdout);
    assert.equal(fs.readFileSync(path.join(f.root,'task.json.stopped'),'utf8'),'owned guardian stopped');
    assert.equal(fs.readFileSync(path.join(f.plugin,'marketplace-owned.txt'),'utf8'),'preserve Marketplace files');
  }finally{f.cleanup();}
});
