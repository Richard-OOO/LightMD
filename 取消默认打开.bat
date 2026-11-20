@echo off
cd /d "%~dp0"
if not exist "LightMD.exe" (
    echo 未找到 LightMD.exe。
    pause
    exit /b 1
)
"LightMD.exe" --unregister
