#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <objbase.h>
#include <filesystem>
#include <string>
#include <vector>
#include <stdexcept>

namespace fs = std::filesystem;
static std::wstring Quote(const std::wstring& value) {
    std::wstring out=L"\""; size_t slashes=0;
    for(wchar_t c:value) {
        if(c==L'\\'){++slashes;continue;}
        out.append(slashes*(c==L'"'?2:1),L'\\'); slashes=0;
        if(c==L'"')out+=L'\\'; out+=c;
    }
    out.append(slashes*2,L'\\'); return out+L'"';
}
static std::wstring PsQuote(const std::wstring& value) {
    std::wstring out=L"'"; for(wchar_t c:value){out+=c;if(c==L'\'')out+=c;} return out+L"'";
}
static std::wstring WindowsPath() {
    wchar_t value[MAX_PATH]; if(!GetWindowsDirectoryW(value,MAX_PATH))throw std::runtime_error("Windows");
    return value;
}
static std::pair<const void*,DWORD> Payload() {
    auto resource=FindResourceW(nullptr,MAKEINTRESOURCEW(101),RT_RCDATA);
    if(!resource)throw std::runtime_error("resource");
    DWORD size=SizeofResource(nullptr,resource);auto bytes=LockResource(LoadResource(nullptr,resource));
    if(!bytes||size<4||static_cast<const char*>(bytes)[0]!='P'||static_cast<const char*>(bytes)[1]!='K')throw std::runtime_error("zip");
    return {bytes,size};
}
static void WritePayload(const fs::path& target) {
    const auto [bytes,size]=Payload();
    HANDLE file=CreateFileW(target.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);
    if(file==INVALID_HANDLE_VALUE)throw std::runtime_error("create");
    DWORD count=0;BOOL ok=WriteFile(file,bytes,size,&count,nullptr);CloseHandle(file);
    if(!ok||count!=size)throw std::runtime_error("write");
}
static void Print(const fs::path& path) {
    auto value=path.u8string()+"\n";DWORD written=0;WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),value.data(),static_cast<DWORD>(value.size()),&written,nullptr);
}
static DWORD Run(const std::wstring& script, HWND window) {
    const auto powershell=WindowsPath()+L"\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    auto command=Quote(powershell)+L" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "+Quote(script);
    STARTUPINFOW startup{};startup.cb=sizeof(startup);PROCESS_INFORMATION process{};
    if(!CreateProcessW(powershell.c_str(),command.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&startup,&process))throw std::runtime_error("launch");
    CloseHandle(process.hThread);
    while(MsgWaitForMultipleObjects(1,&process.hProcess,FALSE,INFINITE,QS_ALLINPUT)==WAIT_OBJECT_0+1){MSG msg;while(PeekMessageW(&msg,nullptr,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageW(&msg);}}
    DWORD result=1;GetExitCodeProcess(process.hProcess,&result);CloseHandle(process.hProcess);
    if(window)DestroyWindow(window);return result;
}
static HWND Progress(HINSTANCE instance) {
    HWND window=CreateWindowExW(WS_EX_TOPMOST,L"STATIC",L"Cider Cast — installation du service Windows",WS_OVERLAPPED|WS_CAPTION|WS_VISIBLE, CW_USEDEFAULT,CW_USEDEFAULT,520,135,nullptr,nullptr,instance,nullptr);
    if(window){CreateWindowW(L"STATIC",L"Installation en cours…\nFFmpeg sera téléchargé si nécessaire. Patientez.",WS_CHILD|WS_VISIBLE,20,18,470,60,window,nullptr,instance,nullptr);UpdateWindow(window);}return window;
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE,PWSTR,int) {
    int count=0;auto args=CommandLineToArgvW(GetCommandLineW(),&count);
    bool extract=count==2&&std::wstring(args[1])==L"--extract-only", self=count==2&&std::wstring(args[1])==L"--self-test";
    LocalFree(args);
    try {
        if(self) {
            if(PsQuote(L"a'b")!=L"'a''b'"||Quote(L"a b\\")!=L"\"a b\\\\\"")return 2;
            std::vector<std::wstring> values={L"a b",L"a\"b",L"a\\\\\"b",L"C:\\a b\\",L"a'b"};
            for(const auto& value:values){int n=0;auto parsed=CommandLineToArgvW((L"setup.exe "+Quote(value)).c_str(),&n);bool ok=n==2&&parsed[1]==value;LocalFree(parsed);if(!ok)return 3;}
            Payload();return 0;
        }
        if(!extract&&MessageBoxW(nullptr,L"Installer le service Windows de Cider Cast ?\n\nInstallez d'abord le plugin dans Cider, puis fermez Cider.\nNode et .NET sont inclus. Aucun pilote supplémentaire.\nSi FFplay manque, FFmpeg sera installé via WinGet (Gyan.FFmpeg), avec acceptation de ses accords de paquet et de source.",L"Cider Cast",MB_YESNO|MB_ICONQUESTION)!=IDYES)return 0;
        wchar_t temp[32768];DWORD length=GetTempPathW(32768,temp);if(!length||length>=32768)throw std::runtime_error("temp");
        GUID id{};wchar_t guid[40];if(FAILED(CoCreateGuid(&id))||!StringFromGUID2(id,guid,40))throw std::runtime_error("guid");
        fs::path tempRoot=fs::path(temp).lexically_normal();if(tempRoot.filename().empty())tempRoot=tempRoot.parent_path();
        const fs::path root=tempRoot/(L"CiderCastSetup-"+std::wstring(guid));
        if(!fs::create_directory(root))throw std::runtime_error("directory");
        const auto zip=root/L"payload.zip", destination=root/L"package";
        WritePayload(zip);
        std::wstring script=L"$ErrorActionPreference='Stop'; try { Expand-Archive -LiteralPath "+PsQuote(zip.wstring())+L" -DestinationPath "+PsQuote(destination.wstring())+L"; ";
        if(!extract)script+=L"& "+PsQuote((destination/L"Installer.ps1").wstring())+L" -Action Install; if ($LASTEXITCODE) { exit $LASTEXITCODE }; ";
        script+=L"} catch { exit 1 }";
        DWORD result=Run(script,extract?nullptr:Progress(instance));
        if(extract){if(result==0)Print(destination);return static_cast<int>(result);}
        // Only remove the unique extraction directory created by this invocation.
        if(root.parent_path()==tempRoot&&root.filename().wstring().rfind(L"CiderCastSetup-",0)==0){std::error_code ignored;fs::remove_all(root,ignored);}
        MessageBoxW(nullptr,result==0?L"Service installé et associé au plugin.\n\nRouvrez Cider, puis Sortie audio. Choisissez une sortie Windows inutilisée avec la roue dentée.":L"Installation non terminée.\n\nVérifiez que Cider est fermé et que le plugin Cider Cast 1.0.0-rc.2 est installé.\nLe détail est disponible dans %TEMP%\\CiderCast-install-result.txt.\nAucune sortie audio n'a été changée par l'installateur.",L"Cider Cast",MB_OK|(result==0?MB_ICONINFORMATION:MB_ICONWARNING));
        return static_cast<int>(result);
    } catch(...) {if(!extract&&!self)MessageBoxW(nullptr,L"Impossible de préparer l'installation. Retéléchargez le paquet officiel de Cider Cast.",L"Cider Cast",MB_OK|MB_ICONERROR);return 1;}
}
