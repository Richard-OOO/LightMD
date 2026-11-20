@echo off
cd /d "%~dp0"
if not exist "LightMD.exe" (
    echo 未找到 LightMD.exe，请先确保 LightMD.exe 在本目录中。
    pause
    exit /b 1
)
"LightMD.exe" --register
