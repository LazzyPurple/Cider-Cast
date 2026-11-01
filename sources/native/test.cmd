@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
cl /nologo /MT /EHsc /std:c++17 /W4 selection.test.cpp /Fe:selection.test.exe /link mmdevapi.lib ole32.lib uuid.lib runtimeobject.lib avrt.lib
if errorlevel 1 exit /b 1
selection.test.exe
if errorlevel 1 exit /b 1
cl /nologo /MT /EHsc /std:c++17 /W4 /utf-8 endpoint.test.cpp /Fe:endpoint.test.exe /link mmdevapi.lib ole32.lib uuid.lib runtimeobject.lib avrt.lib
if errorlevel 1 exit /b 1
endpoint.test.exe
if errorlevel 1 exit /b 1
cl /nologo /MT /EHsc /std:c++17 /W4 routing-journal.test.cpp /Fe:routing-journal.test.exe /link mmdevapi.lib ole32.lib uuid.lib runtimeobject.lib avrt.lib
if errorlevel 1 exit /b 1
routing-journal.test.exe "%TEMP%\cider-journal-%RANDOM%-%RANDOM%.txt"
