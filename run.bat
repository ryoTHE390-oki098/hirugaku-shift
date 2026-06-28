@echo off
cd /d "%~dp0"
if "%ADMIN_PASSWORD%"=="" set ADMIN_PASSWORD=hirugaku-admin
"C:\Users\ryoco\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" app.py 8000
