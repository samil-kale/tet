@echo off
rem `tet` typed into a console: starts TET beside it and returns, the window outliving the console.
start "" "%~dp0..\TET.exe" %*
