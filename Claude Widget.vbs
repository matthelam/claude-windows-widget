' Silent launcher for the Claude usage widget (no console window).
' Double-click to start, or put a shortcut to this file in shell:startup
' to launch the widget automatically at login.
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = appDir
sh.Run """" & appDir & "\node_modules\electron\dist\electron.exe"" .", 0, False
