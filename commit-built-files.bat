@echo off
echo ========================================
echo Committing Built Files for BRAT
echo ========================================

cd /d "%~dp0"

echo.
echo Staging built files...
git add main.js styles.css manifest.json

echo.
echo Creating commit...
git commit -m "Build v2.0.0: Add compiled plugin files for BRAT" -m "Built files for Obsidian BRAT installation:" -m "- main.js (compiled plugin)" -m "- styles.css (plugin styles)" -m "- manifest.json (plugin metadata)" -m "" -m "Version: 2.0.0" -m "Build date: %date% %time%"

if errorlevel 1 (
    echo.
    echo ERROR: Commit failed!
    pause
    exit /b 1
)

echo.
echo Pushing to GitHub...
git push origin main

if errorlevel 1 (
    echo.
    echo ERROR: Push failed!
    pause
    exit /b 1
)

echo.
echo ========================================
echo SUCCESS! Built files pushed to GitHub
echo ========================================
echo.
echo Your repository is now BRAT-ready!
echo.
echo To install in Obsidian:
echo 1. Open Obsidian Settings
echo 2. Go to Community Plugins
echo 3. Click "Browse" next to BRAT
echo 4. Enter your repository URL
echo 5. BRAT will install from main branch
echo.
pause
