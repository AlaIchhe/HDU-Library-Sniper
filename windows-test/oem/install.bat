@echo off
rem ---------------------------------------------------------------------------
rem dockur/windows OEM hook.
rem
rem The container bakes everything under oem/ into the installation media and
rem exposes it as C:\OEM inside the guest. This file is executed by
rem SetupComplete.cmd, which runs as SYSTEM at the end of Windows setup, before
rem any interactive session exists. So it must not do anything that needs a
rem desktop: no GUI installer, no UAC prompt, no screenshot.
rem
rem It only arranges for verify.ps1 to run once in the auto-logon user's session.
rem RunOnce is used instead of a scheduled task on purpose: an ONLOGON task
rem created here with a stored password is a "run whether the user is logged on
rem or not" task, so it lands in session 0 with no desktop and no mapped Z:.
rem RunOnce executes inside the interactive session, elevated (the unattended
rem install disables UAC), which is what the suite needs for screenshots and for
rem HKCU\...\Run landing in the right profile.
rem ---------------------------------------------------------------------------
setlocal
set "LOG=C:\OEM\install.log"

echo [%DATE% %TIME%] install.bat start >> "%LOG%"

reg add "HKLM\Software\Microsoft\Windows\CurrentVersion\RunOnce" /v HduSniperVerify /t REG_SZ /d "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\OEM\verify.ps1 -Watch" /f >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%DATE% %TIME%] ERROR: failed to register RunOnce entry >> "%LOG%"
  exit /b 1
)

echo [%DATE% %TIME%] RunOnce HduSniperVerify registered >> "%LOG%"
endlocal
exit /b 0
