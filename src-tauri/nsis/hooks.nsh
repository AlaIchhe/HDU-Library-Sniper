; Installer hooks for the Windows NSIS package.
;
; 2.0.x 用 WiX/MSI 发行，2.1.0 起改成 NSIS。旧 MSI 的卸载项必须清掉，否则控制面板里会同时
; 存在两个「HDU Library Sniper」，用户点旧的那个卸载会把新装的 exe 一起删掉。
;
; 注意：**不能写死 ProductCode**。WiX 每个版本都重新生成一个，实测 2.0.21 / 2.0.29 / 2.0.30 /
; 2.0.31 / 2.0.32 / 2.0.33 六个版本的 GUID 全不一样，写死任何一个都只能覆盖一部分用户
; （历史版本里写死的那个 GUID 其实一个都没匹配上，等于这条迁移从来没生效过）。
; 这里改成按控制面板卸载项枚举：WindowsInstaller=1 的项就是 MSI，键名即 ProductCode。
; 用户数据目录由应用自己管，这里不碰。
!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'taskkill /F /IM hdu-library-sniper.exe'
  nsExec::ExecToLog 'taskkill /F /IM hdu-sniper-server.exe'

  Push $R0
  Push $R1
  Push $R2

  ; 64 位视图：2.0.x 的 MSI 是 x64 包（ALLUSERS=1）
  SetRegView 64
  StrCpy $R0 0
  legacy_msi_x64_loop:
    EnumRegKey $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $R0
    StrCmp $R1 "" legacy_msi_x64_done
    IntOp $R0 $R0 + 1
    ReadRegStr $R2 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "DisplayName"
    StrCmp $R2 "${PRODUCTNAME}" 0 legacy_msi_x64_loop
    ReadRegDWORD $R2 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "WindowsInstaller"
    StrCmp $R2 "1" 0 legacy_msi_x64_loop
    DetailPrint "Removing legacy MSI $R1"
    nsExec::ExecToLog 'msiexec.exe /x$R1 /qn /norestart'
    Goto legacy_msi_x64_loop
  legacy_msi_x64_done:

  ; 32 位视图兜底：万一有用户装过 32 位包
  SetRegView 32
  StrCpy $R0 0
  legacy_msi_x86_loop:
    EnumRegKey $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $R0
    StrCmp $R1 "" legacy_msi_x86_done
    IntOp $R0 $R0 + 1
    ReadRegStr $R2 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "DisplayName"
    StrCmp $R2 "${PRODUCTNAME}" 0 legacy_msi_x86_loop
    ReadRegDWORD $R2 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "WindowsInstaller"
    StrCmp $R2 "1" 0 legacy_msi_x86_loop
    DetailPrint "Removing legacy MSI $R1"
    nsExec::ExecToLog 'msiexec.exe /x$R1 /qn /norestart'
    Goto legacy_msi_x86_loop
  legacy_msi_x86_done:

  ; 恢复 32 位 installer 的默认视图，后面的注册表写入（卸载项、Run 键）保持原有位置
  SetRegView 32

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
