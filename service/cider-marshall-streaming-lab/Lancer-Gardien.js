var shell = new ActiveXObject('WScript.Shell');
var files = new ActiveXObject('Scripting.FileSystemObject');
if (WScript.Arguments.length !== 1) WScript.Quit(2);
var guardian = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), 'Gardien-Cider.ps1');
var powershell = shell.ExpandEnvironmentStrings('%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
var command = '"' + powershell + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + guardian + '" -NodePath "' + WScript.Arguments(0) + '"';
WScript.Quit(shell.Run(command, 0, true));
