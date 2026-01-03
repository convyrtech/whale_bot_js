@echo off
title Whale VPN Bot
color 0B

echo ===================================================
echo      WHALE VPN BOT - LAUNCHER
echo ===================================================
echo.

cd backend

:: Check if node_modules exists
if not exist "node_modules\" (
    echo [!] First run detected. Installing libraries...
    call npm install
    echo [V] Libraries installed.
    echo.
)

:loop
echo [%time%] Starting VPN Bot...
node index.js
echo [!] Bot crashed or stopped. Restarting in 5 seconds...
timeout /t 5
goto loop