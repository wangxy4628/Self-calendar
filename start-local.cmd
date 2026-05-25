@echo off
cd /d "%~dp0"
netstat -ano | findstr ":5173" | findstr "LISTENING" >nul
if %errorlevel%==0 (
  powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:5173/api/state' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }"
  if errorlevel 1 (
    echo Port 5173 is already in use, but it does not look like the latest Self Calendar service.
    echo Please close the old Self Calendar command window, then run this script again.
    pause
    exit /b 1
  )
  echo Self Calendar is already running at http://localhost:5173
  start "" "http://localhost:5173"
  pause
  exit /b 0
)

echo Starting Self Calendar at http://localhost:5173
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 1; Start-Process 'http://localhost:5173'"
node server.js
pause
