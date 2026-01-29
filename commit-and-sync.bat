@echo off
echo ========================================
echo Committing Letta Code Integration v2.0.0
echo ========================================

cd /d "%~dp0"

echo.
echo Staging all changes...
git add .

echo.
echo Creating commit...
git commit -m "Release v2.0.0: Letta Code Integration - Local Agent" -m "Major release featuring complete Letta Code integration for local AI agent operation." -m "" -m "Features:" -m "- Complete dual-mode support (Cloud + Local)" -m "- 14 vault tools (11 vault + 3 memory)" -m "- Multi-agent support (concurrent connections)" -m "- Message caching (last 200 per agent)" -m "- Comprehensive documentation (60,000+ chars)" -m "" -m "Implementation:" -m "- LettaCodeBridge for subprocess management" -m "- BridgeToolRegistry with 14 tools" -m "- JSON Lines message protocol" -m "- Event-driven architecture" -m "- Security boundaries (blocked folders, write approval)" -m "" -m "Files Added:" -m "- letta-code/types.ts (40 lines)" -m "- letta-code/bridge.ts (340 lines)" -m "- letta-code/tools.ts (1,000 lines)" -m "- 12 documentation files (60,000+ chars)" -m "" -m "Files Modified:" -m "- main.ts (~330 lines added)" -m "" -m "Milestones:" -m "- M1: Proof of Concept (subprocess communication)" -m "- M2: Message Flow (bidirectional messaging)" -m "- M3: Tool Integration (4 core tools)" -m "- M4: Enhanced Features (complete tool set)" -m "- M5: Polish and Release (documentation)" -m "" -m "Testing:" -m "- 80+ test procedures documented" -m "- 10 test categories" -m "- Performance benchmarks included" -m "" -m "Total Implementation:" -m "- Code: ~2,115 lines" -m "- Time: ~8 hours" -m "- Progress: 100%% (5/5 milestones)" -m "" -m "Generated with [Letta Code](https://letta.com)" -m "" -m "Co-Authored-By: Letta <noreply@letta.com>"

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
echo Creating tag v2.0.0...
git tag -a v2.0.0 -m "Release v2.0.0: Local Agent - Letta Code Integration"

echo.
echo Pushing tag to GitHub...
git push origin v2.0.0

if errorlevel 1 (
    echo.
    echo ERROR: Tag push failed!
    pause
    exit /b 1
)

echo.
echo ========================================
echo SUCCESS! Repository synced to GitHub
echo ========================================
echo.
echo Next step: Run build-release.bat
echo.
pause
