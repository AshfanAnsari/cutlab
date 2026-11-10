@echo off
title CutLab — local editor
cd /d "%~dp0"
echo Starting CutLab on http://localhost:5173
echo (First run installs dependencies — that can take a minute.)
call npm install
call npm run dev -- --port 5173
pause
