@echo off
cd /d "%~dp0"
node scripts\set-key.mjs %*
echo.
pause
