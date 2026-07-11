Set WshShell = CreateObject("WScript.Shell")
' 使用 pythonw.exe 启动，不显示命令行窗口
WshShell.Run "pythonw.exe main.py", 0, False
Set WshShell = Nothing
