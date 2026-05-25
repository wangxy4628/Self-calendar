Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
serverCommand = "cmd /c cd /d """ & appDir & """ && node server.js"
openCommand = "cmd /c start ""Self Calendar"" msedge --app=http://localhost:5173"

shell.Run serverCommand, 0, False
WScript.Sleep 1200
shell.Run openCommand, 0, False
