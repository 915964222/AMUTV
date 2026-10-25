@echo off
setlocal
cd /d "%~dp0"
echo Starting YingshiTV server...
start "" http://localhost:9978
node server.js
