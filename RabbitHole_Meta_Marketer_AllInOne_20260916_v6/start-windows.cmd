@echo off
setlocal EnableExtensions DisableDelayedExpansion
where node >nul 2>nul
if errorlevel 1 goto node_missing
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto node_old
if not exist "%~dp0rh-meta.mjs" goto client_missing
if "%~1"=="" goto doctor
node "%~dp0rh-meta.mjs" %*
exit /b %errorlevel%

:doctor
node "%~dp0rh-meta.mjs" doctor
set "RH_META_EXIT=%errorlevel%"
echo.
echo Read START_HERE_KO.md for the next step. No ad was created by doctor.
pause
exit /b %RH_META_EXIT%

:node_missing
echo Node.js was not found. Install Node.js 22 or newer from:
echo https://nodejs.org/en/download
goto setup_error

:node_old
echo Node.js 22 or newer is required. Install it from:
echo https://nodejs.org/en/download
goto setup_error

:client_missing
echo rh-meta.mjs is missing. Extract ALL files from the starter ZIP into one folder.
goto setup_error

:setup_error
echo Reopen your terminal after installation. See START_HERE_KO.md.
if "%~1"=="" pause
exit /b 1
