@echo off
setlocal
title Offline Music and Video Player
cd /d "%~dp0"

echo.
echo   ============================================================
echo      Offline Music and Video Player
echo      (offline local media library)
echo   ============================================================
echo.

set "NODE_EXE="

rem ---- 1) Node from system PATH ----
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if defined NODE_EXE goto found

rem ---- 2) Common Node install locations ----
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if defined NODE_EXE goto found
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if defined NODE_EXE goto found
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined NODE_EXE goto found

rem ---- 3) Portable runtime shipped next to this file ----
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
if defined NODE_EXE goto found

rem ---- 4) Runtime bundled with the app ----
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
  if exist "%%~D\node.exe" if not defined NODE_EXE set "NODE_EXE=%%~D\node.exe"
)
if defined NODE_EXE goto found

echo   [ERROR] Node.js runtime was not found on this PC.
echo.
echo   This player needs Node.js to run its local server.
echo   Please do ONE of the following, then run this file again:
echo.
echo     * Double-click  install-node.bat  in this same folder
echo       (a UAC prompt will appear, click Yes)
echo.
echo     * Or download the LTS version from https://nodejs.org
echo.
pause
exit /b 1

:found
echo   Runtime : %NODE_EXE%
echo.
echo   The browser will open automatically.
echo   Close this window to stop the server.
echo.

"%NODE_EXE%" server.js

if errorlevel 1 (
  echo.
  echo   The server exited unexpectedly. See the messages above.
  echo.
  pause
)
