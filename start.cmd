@echo off
cd /d "%~dp0"
echo Starting... open http://127.0.0.1:8080
node server\main.mjs
pause
