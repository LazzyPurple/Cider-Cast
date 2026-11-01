param([ValidateSet('Check','Install','Remove','Restore')][string]$Action = 'Check')
$ErrorActionPreference = 'Stop'
$packageRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$installRoot = Join-Path $env:LOCALAPPDATA 'CiderCast'
$appRoot = Join-Path $installRoot 'app'
$taskName = 'Cider Marshall - service audio local'
$profileRoot = Join-Path $env:LOCALAPPDATA 'Packages/CiderCollective.Cider_a6qxe093bx5xj/LocalCache/Roaming/sh.cider.dotnet'
$pluginRoot = Join-Path $profileRoot 'plugins/local.marshall-cast'
$ownedService = Join-Path $appRoot 'cider-marshall-streaming-lab'
$stage = 'verification'
$installMutex = $null; $mutexOwned = $false
$oldAppMoved = $false; $oldPluginMoved = $false; $newAppMoved = $false; $newPluginMoved = $false; $serviceAttempted = $false
function Stop-Install([string]$message) {
    $failure = [InvalidOperationException]::new($message); $failure.Data['CiderCastMessage'] = $message; throw $failure
}
function Write-Utf8([string]$file, [string]$content) { [IO.File]::WriteAllText($file, $content, [Text.UTF8Encoding]::new($false)) }
function Assert-Owned([string]$file, [string]$root) {
    if (-not [IO.Path]::GetFullPath($file).StartsWith([IO.Path]::GetFullPath($root) + '\', [StringComparison]::OrdinalIgnoreCase)) { Stop-Install 'Chemin hors du dossier autorise.' }
}
function Assert-Cold {
    if (@(Get-Process -Name Cider -ErrorAction SilentlyContinue).Count) { Stop-Install 'Fermez completement Cider avant de continuer.' }
    if (@(Get-CimInstance Win32_Process | Where-Object {$_.Name -match '^(capture|Sender|ffplay)\.exe$'}).Count) { Stop-Install 'Une capture ou un relais audio est encore actif. Attendez sa liberation.' }
}
function Assert-Package {
    $manifest = Get-Content -LiteralPath (Join-Path $packageRoot 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.version -ne '1.0.0-rc.2' -or -not $manifest.files.Count) { Stop-Install 'Paquet Cider Cast invalide.' }
    $seen = @{}
    foreach ($entry in $manifest.files) {
        $file = [IO.Path]::GetFullPath((Join-Path $packageRoot $entry.path)); Assert-Owned $file $packageRoot
        if ($seen.ContainsKey($file) -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') { Stop-Install 'Manifest du paquet invalide.' }; $seen[$file] = $true
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file).Hash -ne $entry.sha256) { Stop-Install 'Paquet incomplet ou modifie. Telechargez une nouvelle copie.' }
    }
    return $manifest
}
function Find-Player {
    $command = Get-Command ffplay.exe -ErrorAction SilentlyContinue
    if ($command -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) { return $command.Source }
    $link = Join-Path $env:LOCALAPPDATA 'Microsoft/WinGet/Links/ffplay.exe'; if (Test-Path -LiteralPath $link -PathType Leaf) { return $link }
    $packages = Join-Path $env:LOCALAPPDATA 'Microsoft/WinGet/Packages'
    if (Test-Path -LiteralPath $packages) {
        $found = @(Get-ChildItem -LiteralPath $packages -Directory -Filter 'Gyan.FFmpeg*' | ForEach-Object {Get-ChildItem -LiteralPath $_.FullName -File -Filter ffplay.exe -Recurse} | Sort-Object LastWriteTimeUtc -Descending)
        if ($found.Count) { return $found[0].FullName }
    }
    return $null
}
function Service-Root($task) {
    if (-not $task) { return $null }
    $match = [regex]::Match($task.Actions[0].Arguments, '"([^"]+[\\/]Lancer-Gardien\.js)"')
    if (-not $match.Success) { Stop-Install 'Une autre installation utilise le nom de la tache. Aucune modification effectuee.' }
    return Split-Path $match.Groups[1].Value
}
function Stop-IdleService([string]$root) {
    if (-not $root) { return }
    if (Test-Path -LiteralPath (Join-Path $root '../cider-marshall-isolated/native/route-restore.txt')) { Stop-Install 'Terminez la restauration audio : rouvrez Cider, ouvrez Sortie audio, puis refermez Cider.' }
    $listener = @(Get-NetTCPConnection -LocalPort 27275 -State Listen -ErrorAction SilentlyContinue)
    if ($listener.Count) {
        $owner = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $listener[0].OwningProcess)
        if ($owner.Name -ne 'node.exe' -or -not $owner.CommandLine.Contains((Join-Path $root 'server.mjs'))) { Stop-Install 'Le port audio est utilise par un autre programme.' }
        $config = Get-Content -LiteralPath (Join-Path $root '../cider-marshall-isolated/config.json') -Raw | ConvertFrom-Json
        $headers = @{'X-Marshall-Token'=$config.token}
        $status = Invoke-RestMethod -Uri http://127.0.0.1:27275/status -Headers $headers -TimeoutSec 4
        if ($status.active -or $status.pendingRecovery -or $status.output -notin @('direct','unavailable')) { Stop-Install 'La session audio precedente doit etre terminee.' }
        Invoke-RestMethod -Uri http://127.0.0.1:27275/shutdown -Method Post -Headers $headers -ContentType application/json -Body '{}' -TimeoutSec 4 | Out-Null
        for ($i=0;$i -lt 20;$i++) {if (-not @(Get-NetTCPConnection -LocalPort 27275 -State Listen -ErrorAction SilentlyContinue).Count) {return}; Start-Sleep -Milliseconds 100}
        Stop-Install 'Le service precedent ne confirme pas son arret.'
    }
}
function Restore-Task([string]$xml) {
    if ($xml) {Register-ScheduledTask -TaskName $taskName -Xml $xml -Force | Out-Null; Start-ScheduledTask -TaskName $taskName}
    else {if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}}
}
function Wait-Guardian([string]$root) {
    if (-not $root) { return }
    $guardian = [IO.Path]::GetFullPath((Join-Path $root 'Gardien-Cider.ps1'))
    $fileArgument='(?:^|\s)-File\s+"'+[regex]::Escape($guardian)+'"(?:\s|$)'
    for ($i=0;$i -lt 20;$i++) {
        $running = @(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -ne $PID -and $_.Name -in @('powershell.exe','pwsh.exe') -and $_.CommandLine -match $fileArgument})
        if (-not $running.Count) { return }; Start-Sleep -Milliseconds 100
        if($i -eq 10) {
            Assert-Cold
            if(@(Get-NetTCPConnection -LocalPort 27275 -State Listen -ErrorAction SilentlyContinue).Count){Stop-Install 'Service audio encore actif.'}
            foreach($process in $running){Stop-Process -Id $process.ProcessId -ErrorAction Stop}
        }
    }
    Stop-Install 'Ancien gardien encore actif. Aucune nouvelle version activee.'
}
try {
    if ($Action -ne 'Check') {
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $installMutex=[Threading.Mutex]::new($false,'Local\CiderCastInstaller-'+$sid)
        try{$mutexOwned=$installMutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$mutexOwned=$true}
        if(-not $mutexOwned){Stop-Install 'Une autre installation Cider Cast est deja en cours.'}
    }
    if (-not [Environment]::Is64BitOperatingSystem -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64' -or [Environment]::OSVersion.Version.Build -lt 22000) { Stop-Install 'Cette version demande Windows 11 x64.' }
    $cider = Get-AppxPackage -Name CiderCollective.Cider
    if (-not $cider -or [version]$cider.Version -lt [version]'4.0.32.0' -or -not (Test-Path -LiteralPath $profileRoot -PathType Container)) { Stop-Install 'Cider Microsoft Store 4.0.32 ou plus recent est requis. Ouvrez-le une premiere fois, puis fermez-le.' }
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue; $previousService = Service-Root $task
    $player = Find-Player
    if ($Action -eq 'Check') {
        $manifest = Assert-Package
        [pscustomobject]@{Version=$manifest.version;PackageValid=$true;CiderVersion=[string]$cider.Version;CiderClosed=(-not @(Get-Process -Name Cider -ErrorAction SilentlyContinue).Count);PlayerAvailable=!!$player;WingetAvailable=!!(Get-Command winget.exe -ErrorAction SilentlyContinue);PreviousService=!!$previousService;InstallRoot=$installRoot}|ConvertTo-Json
        return
    }
    Assert-Cold
    if ($Action -in @('Remove','Restore')) {
        if (-not $previousService -or [IO.Path]::GetFullPath($previousService) -ne [IO.Path]::GetFullPath($ownedService)) { Stop-Install 'Aucune installation Cider Cast geree ne peut etre retiree ou remplacee.' }
        Stop-IdleService $previousService
        if ($Action -eq 'Remove') {
            & (Join-Path $ownedService 'Gerer-Service.ps1') -Action Remove
            $connectionFile=Join-Path $pluginRoot 'service-connection.json'
            if (Test-Path -LiteralPath $connectionFile) {
                $removed = Join-Path $installRoot ('connection-removed-' + [guid]::NewGuid().ToString('N')+'.json'); Assert-Owned $removed $installRoot; Assert-Owned $connectionFile $pluginRoot
                Move-Item -LiteralPath $connectionFile -Destination $removed
            }
            Write-Output 'Service Windows retire. Le plugin Marketplace reste gere par Cider. Sauvegardes conservees.'; return
        }
        $rollback = Get-Content -LiteralPath (Join-Path $installRoot 'rollback.json') -Raw | ConvertFrom-Json
        $backup = [IO.Path]::GetFullPath($rollback.backup); Assert-Owned $backup (Join-Path $installRoot 'backups')
        if (-not (Test-Path -LiteralPath (Join-Path $backup 'task.xml')) -or -not (Test-Path -LiteralPath (Join-Path $backup 'plugin/plugin.js'))) { Stop-Install 'Aucune version precedente complete ne peut etre restauree.' }
        $savedFiles = Get-Content -LiteralPath (Join-Path $backup 'files.json') -Raw | ConvertFrom-Json
        foreach ($entry in $savedFiles) { $file = Join-Path $backup $entry.path; Assert-Owned $file $backup; if((Get-FileHash -LiteralPath $file).Hash -ne $entry.sha256){Stop-Install 'Sauvegarde modifiee. Restauration refusee.'} }
        Stop-ScheduledTask -TaskName $taskName
        Wait-Guardian $previousService
        $aside = Join-Path $backup ('replaced-' + [guid]::NewGuid().ToString('N')); Assert-Owned $aside $backup; New-Item -ItemType Directory -Path $aside | Out-Null
        Assert-Owned $pluginRoot $profileRoot; Move-Item -LiteralPath $pluginRoot -Destination (Join-Path $aside 'plugin')
        Move-Item -LiteralPath (Join-Path $backup 'plugin') -Destination $pluginRoot
        if (Test-Path -LiteralPath (Join-Path $backup 'app')) {Assert-Owned $appRoot $installRoot; Move-Item -LiteralPath $appRoot -Destination (Join-Path $aside 'app'); Move-Item -LiteralPath (Join-Path $backup 'app') -Destination $appRoot}
        Restore-Task (Get-Content -LiteralPath (Join-Path $backup 'task.xml') -Raw)
        Write-Output 'Version precedente restauree. Rouvrez Cider.'; return
    }
    $manifest = Assert-Package
    $pluginManifest=Join-Path $pluginRoot 'plugin.yml'
    if(-not (Test-Path -LiteralPath $pluginManifest)){Stop-Install 'Installez d abord le plugin Cider Cast dans Cider, puis fermez Cider.'}
    $pluginMetadata=Get-Content -LiteralPath $pluginManifest -Raw
    if($pluginMetadata -notmatch '(?m)^identifier:\s*local\.marshall-cast\s*$' -or $pluginMetadata -notmatch '(?m)^version:\s*1\.0\.0-rc\.2\s*$'){Stop-Install 'Installez le plugin Cider Cast 1.0.0-rc.2 avant ce service.'}
    if ([IO.Path]::GetFullPath($packageRoot) -eq [IO.Path]::GetFullPath($installRoot)) { Stop-Install 'Pour mettre a jour, utilisez une nouvelle archive de distribution.' }
    if ($previousService -and (Test-Path -LiteralPath (Join-Path $previousService '../cider-marshall-isolated/native/route-restore.txt'))) { Stop-Install 'Terminez la restauration de la version precedente avant installation.' }
    $stage = 'dependance audio'
    if (-not $player) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue; if (-not $winget) { Stop-Install 'FFplay manque et WinGet est indisponible. Installez FFmpeg depuis gyan.dev, puis relancez Installer.' }
        & $winget.Source install --id Gyan.FFmpeg --exact --source winget --scope user --silent --disable-interactivity --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { Stop-Install 'Installation de FFmpeg impossible. Aucun plugin modifie.' }
        $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); $player = Find-Player
        if (-not $player) { Stop-Install 'FFplay reste introuvable. Aucun plugin modifie.' }
    }
    $stage = 'preparation'
    $staging = Join-Path $installRoot ('staging-' + [guid]::NewGuid().ToString('N')); Assert-Owned $staging $installRoot
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    foreach ($entry in $manifest.files | Where-Object {$_.path.StartsWith('app/')}) {
        $target = Join-Path $staging $entry.path; Assert-Owned $target $staging; New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
        Copy-Item -LiteralPath (Join-Path $packageRoot $entry.path) -Destination $target
        if ((Get-FileHash -LiteralPath $target).Hash -ne $entry.sha256) { Stop-Install 'Verification de copie impossible. Ancienne version conservee.' }
    }
    $dataRoot = Join-Path $staging 'app/cider-marshall-isolated'; $oldConfig = Join-Path $appRoot 'cider-marshall-isolated/config.json'
    if(-not (Test-Path -LiteralPath $oldConfig) -and $previousService){$oldConfig=Join-Path $previousService '../cider-marshall-isolated/config.json'}
    if (Test-Path -LiteralPath $oldConfig) { $config = Get-Content -LiteralPath $oldConfig -Raw | ConvertFrom-Json; if ($config.token -notmatch '^[a-f0-9]{64}$') {Stop-Install 'Configuration existante invalide.'} }
    else { $bytes=New-Object byte[] 32; $random=[Security.Cryptography.RandomNumberGenerator]::Create(); try{$random.GetBytes($bytes)}finally{$random.Dispose()}; $config=[pscustomobject]@{token=([BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant());endpointId='';target='';playerPath=$player} }
    $config|Add-Member -NotePropertyName playerPath -NotePropertyValue $player -Force; Write-Utf8 (Join-Path $dataRoot 'config.json') ($config|ConvertTo-Json)
    New-Item -ItemType Directory -Force -Path (Join-Path $dataRoot 'native') | Out-Null
    $selectionSource = if (Test-Path -LiteralPath (Join-Path $ownedService 'audio-output.json')) {Join-Path $ownedService 'audio-output.json'} elseif($previousService) {Join-Path $previousService 'audio-output.json'} else {$null}
    if ($selectionSource -and (Test-Path -LiteralPath $selectionSource)) { $selection=Get-Content -LiteralPath $selectionSource -Raw|ConvertFrom-Json; if($selection.endpointId -notmatch '^\{0\.0\.0\.00000000\}\.\{[a-fA-F0-9-]{36}\}$'){Stop-Install 'Ancienne selection invalide.'}; Write-Utf8 (Join-Path $staging 'app/cider-marshall-streaming-lab/audio-output.json') (@{endpointId=$selection.endpointId}|ConvertTo-Json) }
    $newPlugin = Join-Path $staging 'plugin'; New-Item -ItemType Directory -Path $newPlugin | Out-Null
    Get-ChildItem -LiteralPath $pluginRoot -Force|ForEach-Object{Copy-Item -LiteralPath $_.FullName -Destination $newPlugin -Recurse -Force}
    Write-Utf8 (Join-Path $newPlugin 'service-connection.json') (@{schema=1;token=$config.token}|ConvertTo-Json)
    Assert-Cold; $stage = 'activation'; Stop-IdleService $previousService
    if(@(Get-NetTCPConnection -LocalPort 27275 -State Listen -ErrorAction SilentlyContinue).Count){Stop-Install 'Le port audio doit etre libre avant activation.'}
    $previousTaskXml = if($task){Export-ScheduledTask -TaskName $taskName}else{''}
    if($task){Stop-ScheduledTask -TaskName $taskName}
    Wait-Guardian $previousService
    $backup = Join-Path $installRoot ('backups/'+[guid]::NewGuid().ToString('N')); Assert-Owned $backup $installRoot; New-Item -ItemType Directory -Force -Path $backup | Out-Null
    if($previousTaskXml){Write-Utf8 (Join-Path $backup 'task.xml') $previousTaskXml}
    if(Test-Path -LiteralPath $appRoot){Assert-Owned $appRoot $installRoot; Move-Item -LiteralPath $appRoot -Destination (Join-Path $backup 'app'); $oldAppMoved=$true}
    if(Test-Path -LiteralPath $pluginRoot){Assert-Owned $pluginRoot $profileRoot; Move-Item -LiteralPath $pluginRoot -Destination (Join-Path $backup 'plugin'); $oldPluginMoved=$true}
    $files=@(Get-ChildItem -LiteralPath $backup -File -Recurse|ForEach-Object{@{path=$_.FullName.Substring($backup.Length+1);sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()}}); Write-Utf8 (Join-Path $backup 'files.json') (ConvertTo-Json -InputObject $files -Depth 4)
    New-Item -ItemType Directory -Force -Path (Split-Path $pluginRoot)|Out-Null
    Move-Item -LiteralPath (Join-Path $staging 'app') -Destination $appRoot; $newAppMoved=$true
    Move-Item -LiteralPath $newPlugin -Destination $pluginRoot; $newPluginMoved=$true
    $serviceAttempted=$true; & (Join-Path $ownedService 'Gerer-Service.ps1') -Action Install
    Write-Utf8 (Join-Path $installRoot 'rollback.json') (@{backup=$backup}|ConvertTo-Json)
    foreach($name in @('Installer.ps1','Desinstaller.js','Retour-Version-Precedente.js')){Copy-Item -LiteralPath (Join-Path $packageRoot $name) -Destination (Join-Path $installRoot $name)}
    Write-Utf8 (Join-Path $installRoot 'installation.json') (@{version=$manifest.version;installedAt=[DateTimeOffset]::UtcNow.ToString('o');backup=$backup}|ConvertTo-Json)
    Write-Output 'Service Cider Cast installe et associe. Rouvrez Cider, ouvrez Sortie audio puis la roue dentee.'
} catch {
    $message=$_.Exception.Data['CiderCastMessage']; if(-not $message){$message='Operation interrompue. Conservez les sauvegardes.'}
    if($newAppMoved -or $oldAppMoved -or $oldPluginMoved -or $newPluginMoved){
        try {
            if($serviceAttempted -and (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)){Stop-ScheduledTask -TaskName $taskName}
            if($newPluginMoved){Assert-Owned $pluginRoot $profileRoot; Move-Item -LiteralPath $pluginRoot -Destination (Join-Path $staging 'failed-plugin')}
            if($newAppMoved){Assert-Owned $appRoot $installRoot; Move-Item -LiteralPath $appRoot -Destination (Join-Path $staging 'failed-app')}
            if($oldAppMoved){Move-Item -LiteralPath (Join-Path $backup 'app') -Destination $appRoot}
            if($oldPluginMoved){Move-Item -LiteralPath (Join-Path $backup 'plugin') -Destination $pluginRoot}
            Restore-Task $previousTaskXml
        } catch { $message += ' Retour automatique incomplet : conservez le dossier CiderCast et ses sauvegardes.' }
    }
    $result='Cider Cast : '+$stage+' : '+$message; Write-Utf8 (Join-Path $env:TEMP 'CiderCast-install-result.txt') $result; Write-Error $result -ErrorAction Continue; exit 1
} finally {
    if($mutexOwned){$installMutex.ReleaseMutex()}; if($installMutex){$installMutex.Dispose()}
}
