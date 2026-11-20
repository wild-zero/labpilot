@echo off
cd /d "%~dp0"
node scripts\check-model.mjs %*
echo.
pause
