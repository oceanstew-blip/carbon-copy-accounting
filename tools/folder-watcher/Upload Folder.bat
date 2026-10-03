@echo off
rem Double-click: pick a folder, then every receipt photo and PDF in it is uploaded.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Upload-Folder.ps1"
echo.
pause
