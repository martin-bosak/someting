@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0upload-static-site.ps1" %*
