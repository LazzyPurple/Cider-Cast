param([ValidateSet('Install','Remove','Status','Check')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
$name = 'Cider Marshall - service audio local'
$guardian = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Gardien-Cider.ps1'))
$launcher = Join-Path $PSScriptRoot 'Lancer-Gardien.js'
$scriptHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
$node = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../runtime/node.exe'))
if ($Action -eq 'Check') {
    if (-not (Test-Path -LiteralPath $launcher) -or -not (Test-Path -LiteralPath $scriptHost)) { throw 'Lanceur discret absent.' }
    & $guardian -NodePath $node -Check; return
}
if ($Action -eq 'Status') {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    [pscustomobject]@{ Installed = !!$task; State = if ($task) { [string]$task.State } else { 'Absent' } }
    return
}
if (@(Get-Process -Name Cider -ErrorAction SilentlyContinue).Count) { throw 'Fermez completement Cider avant de modifier le demarrage automatique.' }
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$captures = @(Get-CimInstance Win32_Process -Filter "Name = 'capture.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) })
if ($captures.Count) { throw 'La capture audio doit etre terminee avant cette operation.' }
if ($Action -eq 'Remove') {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($task) { Stop-ScheduledTask -TaskName $name; Unregister-ScheduledTask -TaskName $name -Confirm:$false }
    $listener = @(Get-NetTCPConnection -LocalPort 27275 -State Listen -ErrorAction SilentlyContinue)
    if ($listener.Count) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener[0].OwningProcess)"
        $server = Join-Path $PSScriptRoot 'server.mjs'
        if ($owner.Name -eq 'node.exe' -and $owner.CommandLine.Contains($server)) {
            $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../cider-marshall-isolated/config.json') -Raw | ConvertFrom-Json
            try { Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:27275/shutdown' -Headers @{ 'X-Marshall-Token' = $config.token } -ContentType 'application/json' -Body '{}' -TimeoutSec 4 | Out-Null } catch { # Older controllers have no shutdown route; the cold installer checks ownership before stopping them.
            }
        }
    }
    Write-Output 'Demarrage automatique retire. Aucun reglage audio Windows modifie.'
    return
}
& $guardian -NodePath $node -Check
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if (-not (Test-Path -LiteralPath $launcher) -or -not (Test-Path -LiteralPath $scriptHost)) { throw 'Lanceur discret absent.' }
$arguments = '//B //Nologo //E:JScript "' + $launcher + '" "' + $node + '"'
$taskAction = New-ScheduledTaskAction -Execute $scriptHost -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = @(
    New-ScheduledTaskTrigger -AtLogOn -User $user
    New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$settings.Priority = 4
Register-ScheduledTask -TaskName $name -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Description 'Demarre le service audio local avec Cider et l arrete apres sa fermeture. Aucun enregistrement audio.' -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Output 'Demarrage discret installe pour cet utilisateur Windows.'
