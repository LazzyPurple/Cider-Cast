var shell = new ActiveXObject('WScript.Shell');
var files = new ActiveXObject('Scripting.FileSystemObject');
if (shell.Popup('Revenir a la version precedente de Cider Cast ?\n\nFermez Cider et terminez sa restauration audio avant de continuer.', 0, 'Cider Cast', 4 + 32) !== 6) WScript.Quit(0);
var powershell = shell.ExpandEnvironmentStrings('%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
var script = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), 'Installer.ps1');
var result = shell.Run('"' + powershell + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + script + '" -Action Restore', 0, true);
shell.Popup(result === 0 ? 'Version precedente restauree. Rouvrez Cider.' : 'Retour non termine. Verifiez la fermeture de Cider, la restauration audio et la presence de la sauvegarde.', 0, 'Cider Cast', result === 0 ? 64 : 48);
WScript.Quit(result);
