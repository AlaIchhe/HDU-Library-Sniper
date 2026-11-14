; Installer hooks for the Windows NSIS package (currentUser in %LOCALAPPDATA%).
;
; 清理两类历史安装记录，避免控制面板出现重复项或升级后残留：
; 1. 2.0.x WiX/MSI（WindowsInstaller=1，枚举 HKLM Uninstall，ProductCode 随版本变化）；
; 2. 2.1.0–2.1.7 perMachine NSIS（同样写在 HKLM，安装到 Program Files）。
; 从 2.1.8 起切换为 currentUser（%LOCALAPPDATA% + HKCU），后续自动更新不再触发 UAC。
!macro CLEANUP_HKLM_INSTALL VIEW
  SetRegView ${VIEW}
  StrCpy $R0 0
  cleanup_loop_${VIEW}:
    EnumRegKey $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $R0
    StrCmp $R1 "" cleanup_done_${VIEW}
    IntOp $R0 $R0 + 1
    ReadRegStr $R2 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "DisplayName"
    StrCmp $R2 "${PRODUCTNAME}" 0 cleanup_loop_${VIEW}
    ReadRegDWORD $R2 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "WindowsInstaller"
    StrCmp $R2 "1" 0 cleanup_nsis_${VIEW}
    DetailPrint "Removing legacy MSI $R1"
    nsExec::ExecToLog 'msiexec.exe /x$R1 /qn /norestart'
    Goto cleanup_loop_${VIEW}
  cleanup_nsis_${VIEW}:
    ReadRegStr $R3 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "QuietUninstallString"
    StrCmp $R3 "" 0 cleanup_exec_nsis_${VIEW}
    ReadRegStr $R3 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "UninstallString"
    StrCmp $R3 "" cleanup_loop_${VIEW}
    StrCpy $R3 '$R3 /S'
  cleanup_exec_nsis_${VIEW}:
    DetailPrint "Removing legacy perMachine install $R1"
    nsExec::ExecToLog '$R3'
    Goto cleanup_loop_${VIEW}
  cleanup_done_${VIEW}:
!macroend

!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'taskkill /F /IM hdu-library-sniper.exe'
  nsExec::ExecToLog 'taskkill /F /IM hdu-sniper-server.exe'

  Push $R0
  Push $R1
  Push $R2
  Push $R3

  !insertmacro CLEANUP_HKLM_INSTALL 64
  !insertmacro CLEANUP_HKLM_INSTALL 32
  SetRegView 32

  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Preserve the MSI behavior: enable startup at login. The NSIS finish page
  ; starts the app for normal installs.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "HDU-Library-Sniper" '"$INSTDIR\hdu-library-sniper.exe" --background'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /F /IM hdu-library-sniper.exe'
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "HDU-Library-Sniper"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
