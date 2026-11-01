var shell = new ActiveXObject('WScript.Shell');
var files = new ActiveXObject('Scripting.FileSystemObject');
if (shell.Popup('Retirer le plugin et son demarrage automatique ?\n\nFermez Cider avant de continuer. Les sauvegardes seront conservees. FFmpeg restera installe.', 0, 'Cider Cast', 4 + 32) !== 6) WScript.Quit(0);
var powershell = shell.ExpandEnvironmentStrings('%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
var script = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), 'Installer.ps1');
var result = shell.Run('"' + powershell + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + script + '" -Action Remove', 0, true);
shell.Popup(result === 0 ? 'Cider Cast est retire. Les sauvegardes locales sont conservees dans LocalAppData/CiderCast.' : 'Retrait non termine. Fermez Cider et terminez la restauration audio avant de reessayer.', 0, 'Cider Cast', result === 0 ? 64 : 48);
WScript.Quit(result);
