param([string]$NodePath = (Join-Path $PSScriptRoot '../runtime/node.exe'), [switch]$Check)
$ErrorActionPreference = 'Stop'
$server = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'server.mjs'))
$configPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../cider-marshall-isolated/config.json'))
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf) -or -not (Test-Path -LiteralPath $server) -or -not (Test-Path -LiteralPath $configPath)) { throw 'Installation du service audio incomplete.' }
if ($Check) {
    foreach ($command in @('Get-NetTCPConnection', 'Get-CimInstance', 'Invoke-RestMethod', 'Start-Process')) { if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Commande indisponible : $command" } }
    Write-Output 'Prerequis du gardien verifies ; aucun processus lance ou arrete.'
    return
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = [Threading.Mutex]::new($false, ('Local\CiderMarshallGuardian-' + $sid))
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { $mutex.Dispose(); return }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$headers = @{ 'X-Marshall-Token' = $config.token }
$lastCiderAt = [DateTimeOffset]::UtcNow
$lastMessage = ''
function Write-State([string]$message) {
    if ($message -eq $script:lastMessage) { return }
    $script:lastMessage = $message
    try {
        $log = Join-Path $PSScriptRoot 'guardian.log'
        if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 65536) { Move-Item -LiteralPath $log -Destination ($log + '.1') -Force }
        Add-Content -LiteralPath $log -Value ([DateTimeOffset]::UtcNow.ToString('o') + ' ' + $message) -Encoding utf8
    } catch { # Logging must not affect Cider or its audio.
    }
}
Write-State 'Gardien demarre ; attente de Cider.'
try {
    while ($true) {
        try {
            $cider = @(Get-Process -Name Cider -ErrorAction SilentlyContinue)
            if ($cider.Count) { $lastCiderAt = [DateTimeOffset]::UtcNow }
            $listener = @(Get-NetTCPConnection -LocalPort 27275 -State Listen -ErrorAction SilentlyContinue)
            if ($listener.Count) {
                $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener[0].OwningProcess)"
                if ($owner.Name -ne 'node.exe' -or -not $owner.CommandLine.Contains($server)) { Write-State 'Port occupe par un autre service ; aucune intervention.'; Start-Sleep -Seconds 3; continue }
                $state = Invoke-RestMethod -Uri 'http://127.0.0.1:27275/status' -Headers $headers -TimeoutSec 3
                if ($state.version -ne '1.0.0-rc.2') { Write-State 'Version du service incompatible ; installation a froid necessaire.'; Start-Sleep -Seconds 3; continue }
                if (-not $cider.Count -and ([DateTimeOffset]::UtcNow - $lastCiderAt).TotalSeconds -ge 5) {
                    # The service refuses shutdown while any capture or Cast cleanup remains active.
                    Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:27275/shutdown' -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 4 | Out-Null
                    Write-State 'Cider ferme ; service audio arrete proprement.'
                } else { Write-State 'Service audio disponible pour Cider.' }
            } elseif ($cider.Count) {
                Start-Process -FilePath $NodePath -ArgumentList ('"' + $server + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'server-error.log')
                Write-State 'Demarrage discret du service audio.'
            }
        } catch { Write-State 'Service audio en transition ou indisponible ; nouvelle verification automatique.' }
        Start-Sleep -Seconds 3
    }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
