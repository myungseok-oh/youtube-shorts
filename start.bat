@echo off
echo [youtube-shorts] Stopping existing server on port 9000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":9000.*LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo [youtube-shorts] Starting server...
cd /d C:\git\youtube-shorts
python app.py
pause
