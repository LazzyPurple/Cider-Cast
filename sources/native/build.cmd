@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
cl /nologo /MT /EHsc /std:c++17 /W4 capture.cpp /Fe:capture.exe /link mmdevapi.lib ole32.lib uuid.lib runtimeobject.lib avrt.lib
