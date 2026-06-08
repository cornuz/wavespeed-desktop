@echo off
REM Change to repo root and run dev with COMPOSER_AUTO_TEST_EXPORT=1
cd /d "%~dp0.."
set COMPOSER_AUTO_TEST_EXPORT=1
npm run dev
