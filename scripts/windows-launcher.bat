@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Plan Detective AI tools require Node.js 22 or newer. 1>&2
  exit /b 127
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo Plan Detective AI tools require Node.js 22 or newer. 1>&2
  exit /b 127
)
node "%~dp0..\..\backend\plan-detective-runtime.mjs" %*
exit /b %ERRORLEVEL%
