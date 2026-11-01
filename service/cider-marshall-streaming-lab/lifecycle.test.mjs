import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createService } from './server.mjs';

test('démarrage Windows : priorité normale et relance périodique sans instance parallèle', { skip: process.platform !== 'win32' }, () => {
  const check = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:CAST_TEST_INSTALLER,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Invalid installer'}
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$node=$env:CAST_TEST_NODE
$launcher=Join-Path (Split-Path $env:CAST_TEST_INSTALLER) 'Lancer-Gardien.js'
$scriptHost=Join-Path $env:SystemRoot 'System32\wscript.exe'
$assignments=$ast.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -in @('$arguments','$taskAction','$trigger','$settings','$settings.Priority')},$true)
foreach($assignment in $assignments){. ([scriptblock]::Create($assignment.Extent.Text.Replace('$PSScriptRoot','(Split-Path $env:CAST_TEST_INSTALLER)')))}
if($taskAction.Execute -ne $scriptHost -or $taskAction.Arguments -notlike '//B //Nologo //E:JScript *' -or -not $taskAction.Arguments.Contains($launcher)){throw 'Guardian launched through a console host'}
if($settings.Priority -ne 4){throw 'Missing normal priority'}
if($trigger.Count -ne 2 -or $trigger[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or $trigger[1].Repetition.Interval -ne 'PT1M' -or $trigger[1].Repetition.Duration){throw 'Missing logon or recurring recovery trigger'}
if($settings.MultipleInstances -ne 2 -or $settings.ExecutionTimeLimit -ne 'PT0S'){throw 'Changed lifecycle safeguards'}
Write-Output 'Startup settings passed'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { ...process.env, CAST_TEST_NODE: process.execPath, CAST_TEST_INSTALLER: fileURLToPath(new URL('./Gerer-Service.ps1', import.meta.url)) },
  });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Startup settings passed/);
});

test('lanceur Windows : console cachée, chemin avec espaces et durée/code du gardien préservés', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cider hidden guardian '));
  fs.copyFileSync(new URL('./Lancer-Gardien.js', import.meta.url), path.join(root, 'Lancer-Gardien.js'));
  fs.writeFileSync(path.join(root, 'Gardien-Cider.ps1'), String.raw`
param([string]$NodePath)
$ErrorActionPreference='Stop'
if($NodePath -ne $env:CAST_TEST_NODE){throw 'Node path lost'}
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class HiddenGuardianTest { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd); }'
if([HiddenGuardianTest]::IsWindowVisible([HiddenGuardianTest]::GetConsoleWindow())){throw 'Visible console'}
[Threading.Thread]::Sleep(300)
exit 23
`);
  try {
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'wscript.exe'), ['//B', '//Nologo', '//E:JScript', path.join(root, 'Lancer-Gardien.js'), process.execPath], {
      windowsHide: true, timeout: 15000, env: { ...process.env, CAST_TEST_NODE: process.execPath },
    });
    assert.equal(result.status, 23, 'Hidden launcher must wait for the guardian and preserve its exit code');
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('cider hidden guardian '));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('arrêt authentifié : interdit pendant une session, aucune restauration effacée', async () => {
  const token = 'e'.repeat(64);
  const service = createService({ token }, { recoveryPending: () => true });
  await new Promise(resolve => service.control.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + service.control.address().port;
  try {
    const status = await (await fetch(base + '/status', { headers: { 'X-Marshall-Token': token } })).json();
    assert.equal(status.phase, 'restore-pending'); assert.equal(status.needsRestart, false);
    const local = await fetch(base + '/local', { method: 'POST', headers: { 'X-Marshall-Token': token }, body: '{}' });
    assert.equal(local.status, 409); assert.match((await local.json()).error, /Fermez puis rouvrez Cider/);
    assert.equal((await fetch(base + '/shutdown', { method: 'POST', body: '{}' })).status, 403);
    const closed = new Promise(resolve => service.control.once('close', resolve));
    const response = await fetch(base + '/shutdown', { method: 'POST', headers: { 'X-Marshall-Token': token }, body: '{}' });
    assert.equal(response.status, 200); assert.equal((await response.json()).stopped, true);
    await closed;
  } finally { if (service.control.listening) { await service.close(); service.control.closeAllConnections(); await new Promise(resolve => service.control.close(resolve)); } }
});

test('gardien Windows : un démarrage avec Cider, arrêt différé, aucun autre programme arrêté', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cider-guardian-test-'));
  const streaming = path.join(root, 'streaming'); fs.mkdirSync(streaming);
  fs.mkdirSync(path.join(root, 'cider-marshall-isolated'));
  fs.writeFileSync(path.join(root, 'cider-marshall-isolated/config.json'), JSON.stringify({ token: 'test-only' }));
  fs.writeFileSync(path.join(streaming, 'server.mjs'), '');
  const guardian = fs.readFileSync(new URL('./Gardien-Cider.ps1', import.meta.url), 'utf8').replace('Local\\CiderMarshallGuardian-', 'Local\\CiderMarshallGuardian-test-' + randomUUID() + '-');
  fs.writeFileSync(path.join(streaming, 'Gardien-Cider.ps1'), guardian);
  // Process and HTTP commands are fakes; only the guardian loop and its real grace-period clock run.
  const harness = String.raw`
$ErrorActionPreference='Stop'
$script:cycle=0; $script:running=$false; $script:starts=0; $script:stops=0
$server=Join-Path $PSScriptRoot 'streaming/server.mjs'
function Get-Process { param($Name) if($script:cycle -lt 2){ [pscustomobject]@{Id=123} } }
function Get-NetTCPConnection { param($LocalPort,$State) if($script:running -or $env:CAST_TEST_FOREIGN -eq '1'){ [pscustomobject]@{OwningProcess=456} } }
function Get-CimInstance { param($ClassName,$Filter) [pscustomobject]@{Name=if($env:CAST_TEST_FOREIGN -eq '1'){'foreign.exe'}else{'node.exe'};CommandLine=$server} }
function Start-Process { param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError) if($WindowStyle -ne 'Hidden'){throw 'Visible window'}; $script:starts++; $script:running=$true }
function Invoke-RestMethod { param($Uri,$Method,$Headers,$ContentType,$Body,$TimeoutSec) if($Uri.EndsWith('/shutdown')){ if($script:cycle -lt 2){throw 'Cider still open'}; $script:stops++; $script:running=$false }else{ [pscustomobject]@{version='1.0.0-rc.2';active=$false;output='direct'} } }
function Start-Sleep { param($Seconds) $script:cycle++; if($script:cycle -gt $(if($env:CAST_TEST_FOREIGN -eq '1'){2}else{10})){throw 'TEST_END'}; [Threading.Thread]::Sleep(800) }
try { & (Join-Path $PSScriptRoot 'streaming/Gardien-Cider.ps1') -NodePath $env:CAST_TEST_NODE } catch { if($_.Exception.Message -ne 'TEST_END'){throw} }
if($env:CAST_TEST_FOREIGN -eq '1'){ if($script:starts -ne 0 -or $script:stops -ne 0){throw 'Foreign service modified'} }
elseif($script:starts -ne 1 -or $script:stops -ne 1){throw "Unexpected lifecycle: starts=$script:starts stops=$script:stops"}
Write-Output 'Guardian lifecycle passed'
`;
  fs.writeFileSync(path.join(root, 'test.ps1'), harness.replaceAll('$script:', '$global:'));
  try {
    for (const foreign of ['0', '1']) {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'test.ps1')], { encoding: 'utf8', timeout: 20000, windowsHide: true, env: { ...process.env, CAST_TEST_NODE: process.execPath, CAST_TEST_FOREIGN: foreign } });
      assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /lifecycle passed/);
    }
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('cider-guardian-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
