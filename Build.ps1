param([string]$DotNetPath='',[string]$RuntimeCache='')
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($PSScriptRoot)
$app=Join-Path $root 'service';$work=Join-Path $root '.build';$runtime=Join-Path $app 'runtime'
$lock=Get-Content -LiteralPath (Join-Path $root 'runtime-lock.json') -Raw|ConvertFrom-Json
if(Test-Path -LiteralPath (Join-Path $root 'dist')){throw 'Preserve the existing dist folder before rebuilding.'}
New-Item -ItemType Directory -Force -Path $work,$runtime|Out-Null
function Get-Verified([string]$url,[string]$file,[string]$hash,[string]$algorithm) {
    if($url -notmatch '^https://(?:nodejs\.org|builds\.dotnet\.microsoft\.com)/'){throw 'Unexpected runtime host.'}
    if(-not (Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file -Algorithm $algorithm).Hash -ne $hash){Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file}
    if((Get-FileHash -LiteralPath $file -Algorithm $algorithm).Hash -ne $hash){throw 'Runtime checksum mismatch.'}
}
if($RuntimeCache) {
    foreach($entry in $lock.cacheFiles) {
        $from=[IO.Path]::GetFullPath((Join-Path $RuntimeCache $entry.path));$to=[IO.Path]::GetFullPath((Join-Path $runtime $entry.path))
        if(-not $from.StartsWith([IO.Path]::GetFullPath($RuntimeCache)+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $to.StartsWith($runtime+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Runtime cache path invalid.'}
        if((Get-FileHash -LiteralPath $from).Hash -ne $entry.sha256){throw 'Runtime cache checksum mismatch.'}
        New-Item -ItemType Directory -Force -Path (Split-Path $to)|Out-Null;Copy-Item -LiteralPath $from -Destination $to -Force
    }
} else {
    Get-Verified $lock.node.url (Join-Path $runtime 'node.exe') $lock.node.sha256 'SHA256'
    Copy-Item -LiteralPath (Join-Path $root 'licenses/NODE-LICENSE.txt') -Destination (Join-Path $runtime 'NODE-LICENSE.txt')
    $zip=Join-Path $work 'dotnet-runtime.zip';Get-Verified $lock.dotnet.url $zip $lock.dotnet.sha512 'SHA512'
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $runtime 'dotnet') -Force
}
if(-not $DotNetPath){$DotNetPath=(Get-Command dotnet.exe -ErrorAction Stop).Source}
if((& $DotNetPath --version) -notmatch '^10\.'){throw '.NET 10 SDK required.'}
$vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs=& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if(-not $vs){throw 'Visual C++ Build Tools required.'}
$vcvars=Join-Path $vs 'VC/Auxiliary/Build/vcvars64.bat'
$native=Join-Path $app 'cider-marshall-streaming-lab/native';New-Item -ItemType Directory -Force -Path $native|Out-Null
$nativeCommand='@echo off'+[Environment]::NewLine+'call "'+$vcvars+'" >nul'+[Environment]::NewLine+'if errorlevel 1 exit /b 1'+[Environment]::NewLine+'cl /nologo /MT /EHsc /std:c++17 /utf-8 /W4 "'+(Join-Path $root 'sources/native/capture.cpp')+'" /Fo:"'+(Join-Path $work 'capture.obj')+'" /Fe:"'+(Join-Path $native 'capture.exe')+'" /link mmdevapi.lib ole32.lib uuid.lib runtimeobject.lib avrt.lib'+[Environment]::NewLine+'exit /b %errorlevel%'
[IO.File]::WriteAllText((Join-Path $work 'build-native.cmd'),$nativeCommand,[Text.UTF8Encoding]::new($false))
& (Join-Path $work 'build-native.cmd');if($LASTEXITCODE){throw 'Native capture build failed.'}
$sender=Join-Path $app 'cider-marshall-streaming-lab/sender/bin/Release/net10.0'
& $DotNetPath build (Join-Path $root 'sources/sender/Sender.csproj') -c Release -p:RestoreLockedMode=true -o $sender --disable-build-servers
if($LASTEXITCODE){throw 'Sender build failed.'}
Push-Location (Join-Path $app 'cider-marshall-isolated')
try{& npm.cmd ci --ignore-scripts --no-audit --no-fund;if($LASTEXITCODE){throw 'Node dependency restore failed.'}}finally{Pop-Location}
& (Join-Path $runtime 'dotnet/dotnet.exe') (Join-Path $sender 'Sender.dll') --self-test
if($LASTEXITCODE){throw 'Sender self-tests failed.'}
& (Join-Path $runtime 'node.exe') (Join-Path $root 'scripts/build-packages.mjs')
if($LASTEXITCODE){throw 'Package build failed.'}
$setup=Join-Path $root 'setup';$payload=Join-Path $root 'dist/Cider-Cast-Service-1.0.0-rc.2-Windows-x64.zip'
[IO.File]::WriteAllText((Join-Path $setup 'setup.rc'),('101 RCDATA "'+$payload.Replace('\','\\')+'"'),[Text.UTF8Encoding]::new($false))
$setupCommand='@echo off'+[Environment]::NewLine+'call "'+$vcvars+'" >nul'+[Environment]::NewLine+'if errorlevel 1 exit /b 1'+[Environment]::NewLine+'cd /d "'+$setup+'"'+[Environment]::NewLine+'rc /nologo /fo "'+(Join-Path $work 'setup.res')+'" setup.rc'+[Environment]::NewLine+'if errorlevel 1 exit /b 1'+[Environment]::NewLine+'cl /nologo /MT /EHsc /std:c++17 /utf-8 /W4 setup.cpp "'+(Join-Path $work 'setup.res')+'" /Fo:"'+(Join-Path $work 'setup.obj')+'" /Fe:"'+(Join-Path $root 'dist/Cider-Cast-Service-1.0.0-rc.2-Windows-x64.exe')+'" /link /SUBSYSTEM:WINDOWS /MANIFEST:EMBED /MANIFESTINPUT:setup.manifest user32.lib shell32.lib ole32.lib'+[Environment]::NewLine+'exit /b %errorlevel%'
[IO.File]::WriteAllText((Join-Path $work 'build-setup.cmd'),$setupCommand,[Text.UTF8Encoding]::new($false))
& (Join-Path $work 'build-setup.cmd');if($LASTEXITCODE){throw 'Setup build failed.'}
$hashes=Get-ChildItem -LiteralPath (Join-Path $root 'dist') -File|Where-Object {$_.Extension -in @('.exe','.zip')}|Sort-Object Name|ForEach-Object{(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()+'  '+$_.Name}
[IO.File]::WriteAllLines((Join-Path $root 'dist/SHA256SUMS.txt'),$hashes,[Text.UTF8Encoding]::new($false))
Write-Output 'Built Marketplace ZIP and Windows service EXE. No installation performed.'
