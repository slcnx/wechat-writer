@echo off
chcp 65001 >nul
title WeChat Writer
cd /d "%~dp0.."
node src\server.js
if errorlevel 1 pause
