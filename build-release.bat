@echo off
echo ========================================
echo Building Rainmaker Obsidian v2.0.0
echo ========================================

cd /d "%~dp0"

echo.
echo Installing dependencies (if needed)...
call npm install

if errorlevel 1 (
    echo.
    echo ERROR: npm install failed!
    pause
    exit /b 1
)

echo.
echo Building plugin...
call npm run build

if errorlevel 1 (
    echo.
    echo ERROR: Build failed!
    pause
    exit /b 1
)

echo.
echo Verifying build output...
if not exist "main.js" (
    echo ERROR: main.js not found!
    pause
    exit /b 1
)
if not exist "styles.css" (
    echo ERROR: styles.css not found!
    pause
    exit /b 1
)
if not exist "manifest.json" (
    echo ERROR: manifest.json not found!
    pause
    exit /b 1
)

echo.
echo Build artifacts verified:
dir main.js | find "main.js"
dir styles.css | find "styles.css"
dir manifest.json | find "manifest.json"

echo.
echo ========================================
echo SUCCESS! Plugin built successfully
echo ========================================
echo.
echo Build artifacts are ready:
echo - main.js
echo - styles.css
echo - manifest.json
echo.
echo You can now:
echo 1. Commit these built files (run commit-built-files.bat)
echo 2. Install via BRAT in Obsidian
echo.
pause
