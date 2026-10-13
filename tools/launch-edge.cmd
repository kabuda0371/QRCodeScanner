@echo off
rem Launcher shell (ASCII only) -> delegates to launch-edge.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-edge.ps1" %*
exit /b %errorlevel%
