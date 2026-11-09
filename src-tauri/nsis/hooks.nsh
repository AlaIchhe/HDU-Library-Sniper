; Installer hooks for the Windows NSIS package.
;
; The old releases were MSI packages. Keep the data directory (handled by the
; app itself), but remove the old MSI registration and files before NSIS copies
; the new executable. 1605 (unknown product) is intentionally ignored.
!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'taskkill /F /IM hdu-library-sniper.exe'
  nsExec::ExecToLog 'taskkill /F /IM hdu-sniper-server.exe'
  nsExec::ExecToLog 'msiexec.exe /x{5839189D-9BAF-4DCD-BD85-B50C768AA3E2} /qn /norestart'
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
