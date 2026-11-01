var shell = new ActiveXObject('WScript.Shell');
var files = new ActiveXObject('Scripting.FileSystemObject');
var folder = files.GetParentFolderName(WScript.ScriptFullName);
if (shell.Popup('Installer Cider Cast pour cet utilisateur Windows ?\n\nFermez Cider avant de continuer. Node et .NET sont inclus.\nSi FFplay manque, FFmpeg sera installe via WinGet (Gyan.FFmpeg), avec acceptation de ses accords de paquet et de source.\nAucun pilote audio ne sera installe.', 0, 'Cider Cast', 4 + 32) !== 6) WScript.Quit(0);
var powershell = shell.ExpandEnvironmentStrings('%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
var result = shell.Run('"' + powershell + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + files.BuildPath(folder, 'Installer.ps1') + '" -Action Install', 0, true);
var errorFile = files.BuildPath(shell.ExpandEnvironmentStrings('%TEMP%'), 'CiderCast-install-result.txt');
var detail = ''; if (result !== 0 && files.FileExists(errorFile)) { var reader = files.OpenTextFile(errorFile, 1); detail = reader.Read(4096); reader.Close(); }
shell.Popup(result === 0 ? 'Cider Cast est installe.\n\nRouvrez Cider, ouvrez Sortie audio, puis la roue dentee pour choisir une sortie Windows inutilisee.' : 'Installation non terminee.\n\n' + detail, 0, 'Cider Cast', result === 0 ? 64 : 48);
WScript.Quit(result);
