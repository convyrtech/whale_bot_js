@echo off
title Whale Bot Tracker
color 0A

echo ===================================================
echo      WHALE TRACKER BOT - LAUNCHER
echo ===================================================
echo.

:: Check if node_modules exists
if not exist "node_modules\" (
    echo [!] First run detected. Installing libraries...
    call npm install
    echo [V] Libraries installed.
    echo.
)

:loop
echo [%time%] Starting Bot...
node index.js
echo.
echo [!] Bot crashed or stopped. Restarting in 5 seconds...
echo     Press Ctrl+C to stop completely.
timeout /t 5 >nul
goto loop