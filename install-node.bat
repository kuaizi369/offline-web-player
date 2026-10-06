@echo off
setlocal
title Install Node.js runtime (all users)
cd /d "%~dp0"

set "VER=24.21.0"
set "MSI=%TEMP%\node-v%VER%-x64.msi"
set "URL=https://nodejs.org/dist/v%VER%/node-v%VER%-x64.msi"
set "SHA=bb0eaee134f9357f22aea915ee793343e627aefc1e66488164bac6915bce2cac"

echo.
echo   ============================================================
echo      Install Node.js LTS v%VER%  (all users of this PC)
echo   ============================================================
echo.

rem ---- check administrator rights ----
set "ISADMIN=0"
for /f %%A in ('powershell -NoProfile -Command "if ((New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { \"1\" } else { \"0\" }"') do set "ISADMIN=%%A"

if "%ISADMIN%"=="0" (
  echo   Administrator rights are required for an all-users install.
  echo.
  echo   A UAC prompt will now appear. Enter an administrator
  echo   password ^(or click Yes^) to continue.
  echo.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  echo   If nothing happened, run this file again and approve the prompt.
  echo.
  pause
  exit /b 0
)

echo   Running with administrator rights. Good.
echo.

rem ---- download installer if not cached ----
if not exist "%MSI%" (
  echo   Downloading Node.js installer, please wait...
  curl -L --fail --silent --show-error -o "%MSI%" "%URL%"
  if errorlevel 1 (
    echo.
    echo   [ERROR] Download failed.
    echo   Please install Node.js manually from https://nodejs.org
    echo.
    pause
    exit /b 1
  )
) else (
  echo   Using cached installer: %MSI%
)
echo.

rem ---- verify SHA-256 ----
set "HASH="
for /f %%H in ('powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath '%MSI%').Hash.ToLower()"') do set "HASH=%%H"
echo   SHA256 : %HASH%
echo   Expected: %SHA%
if /i not "%HASH%"=="%SHA%" (
  echo.
  echo   [ERROR] Checksum mismatch - the download may be corrupted.
  echo   Deleting it so you can retry.
  del /f /q "%MSI%"
  pause
  exit /b 1
)
echo   Checksum OK.
echo.

rem ---- install ----
echo   Installing, please wait...
msiexec /i "%MSI%" /qn /norestart ALLUSERS=1
set "RC=%ERRORLEVEL%"
echo   msiexec exit code: %RC%
echo.

if exist "%ProgramFiles%\nodejs\node.exe" (
  echo   ============================================================
  echo      SUCCESS - Node.js is now installed for all users.
  echo      Location: %ProgramFiles%\nodejs
  echo   ============================================================
  echo.
  for /f %%V in ('"%ProgramFiles%\nodejs\node.exe" -v') do echo   node version: %%V
  echo.
  echo   You can now double-click the player launcher as usual.
) else (
  echo   [WARNING] Installation may not have completed.
  echo   Please install Node.js manually from https://nodejs.org
)
echo.
pause
