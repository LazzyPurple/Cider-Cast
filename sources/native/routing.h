#include <roapi.h>
#include <winstring.h>
#include <appmodel.h>
#include <fstream>
#include <filesystem>
#include <regex>

// Windows 21H2+ ABI: https://github.com/File-New-Project/EarTrumpet/blob/master/EarTrumpet/Interop/MMDeviceAPI/IAudioPolicyConfigFactoryVariantFor21H2.cs
struct __declspec(uuid("ab3d4648-e242-459f-b02f-541c70306324")) AppAudioPolicy : IInspectable {
#define UNUSED(n) virtual HRESULT STDMETHODCALLTYPE unused##n() = 0;
  UNUSED(0) UNUSED(1) UNUSED(2) UNUSED(3) UNUSED(4) UNUSED(5) UNUSED(6)
  UNUSED(7) UNUSED(8) UNUSED(9) UNUSED(10) UNUSED(11) UNUSED(12) UNUSED(13)
  UNUSED(14) UNUSED(15) UNUSED(16) UNUSED(17) UNUSED(18)
#undef UNUSED
  virtual HRESULT STDMETHODCALLTYPE SetEndpoint(DWORD pid, EDataFlow flow, ERole role, HSTRING id) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetEndpoint(DWORD pid, EDataFlow flow, ERole role, HSTRING* id) = 0;
};
struct Routing {
  ComPtr<AppAudioPolicy> policy;
  DWORD pid;
  HSTRING before[2]{};
  bool changed[2]{};
  explicit Routing(DWORD id) : pid(id) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) throw HRESULT_FROM_WIN32(GetLastError());
    wchar_t app[1024]; UINT32 size = 1024;
    LONG result = GetApplicationUserModelId(process, &size, app); CloseHandle(process);
    if (result != ERROR_SUCCESS || std::wstring(app) != L"CiderCollective.Cider_a6qxe093bx5xj!App") throw E_ACCESSDENIED;
    HSTRING name; const wchar_t* runtime = L"Windows.Media.Internal.AudioPolicyConfig";
    check(WindowsCreateString(runtime, static_cast<UINT32>(wcslen(runtime)), &name));
    HRESULT hr = RoGetActivationFactory(name, __uuidof(AppAudioPolicy), &policy);
    WindowsDeleteString(name); check(hr);
  }
  void snapshot() {
    for (int r = 0; r < 2; r++) check(policy->GetEndpoint(pid, eRender, static_cast<ERole>(r), &before[r]));
  }
  HRESULT restore() {
    HRESULT result = S_OK;
    for (int r = 0; r < 2; r++) if (changed[r]) {
      HRESULT hr = policy->SetEndpoint(pid, eRender, static_cast<ERole>(r), before[r]);
      if (SUCCEEDED(hr)) changed[r] = false; else result = hr;
    }
    return result;
  }
  ~Routing() { restore(); for (auto id : before) WindowsDeleteString(id); }
  void apply(const wchar_t* endpoint) {
    std::wstring full = L"\\\\?\\SWD#MMDEVAPI#" + std::wstring(endpoint) + L"#{e6327cad-dcec-4949-ae8a-991e976a79d2}";
    HSTRING id; check(WindowsCreateString(full.c_str(), static_cast<UINT32>(full.size()), &id));
    for (int r = 0; r < 2; r++) {
      HRESULT hr = policy->SetEndpoint(pid, eRender, static_cast<ERole>(r), id);
      if (FAILED(hr)) { WindowsDeleteString(id); check(hr); }
      changed[r] = true;
    }
    WindowsDeleteString(id);
  }
};
std::filesystem::path recoveryFile() {
  wchar_t image[32768]; DWORD size = GetModuleFileNameW(nullptr, image, 32768);
  if (!size || size >= 32768) throw E_FAIL;
  // Share the existing restoration journal when switching between WAV and Streaming.
  return std::filesystem::path(image).parent_path().parent_path().parent_path() / L"cider-marshall-isolated" / L"native" / L"route-restore.txt";
}
struct RecoveryState { std::wstring endpoint, muted, previous[2]; };
RecoveryState readRecoveryFile(const std::filesystem::path& file, const wchar_t* endpoint = nullptr) {
  if (std::filesystem::file_size(file) > 2048) throw E_INVALIDARG;
  std::wifstream input(file); RecoveryState saved; std::wstring extra;
  if (!std::getline(input, saved.endpoint) || !std::getline(input, saved.muted) || !std::getline(input, saved.previous[0]) || !std::getline(input, saved.previous[1]) || std::getline(input, extra)) throw E_INVALIDARG;
  const std::wregex devicePattern(LR"(\{0\.0\.0\.00000000\}\.\{[a-fA-F0-9-]{36}\})");
  if (!std::regex_match(saved.endpoint, devicePattern) || (endpoint && saved.endpoint != endpoint) || (saved.muted != L"0" && saved.muted != L"1")) throw E_INVALIDARG;
  const std::wregex endpointPattern(LR"(\\\\\?\\SWD#MMDEVAPI#\{0\.0\.0\.00000000\}\.\{[a-fA-F0-9-]{36}\}#\{e6327cad-dcec-4949-ae8a-991e976a79d2\})");
  for (const auto& value : saved.previous) if (!value.empty() && !std::regex_match(value, endpointPattern)) throw E_INVALIDARG;
  return saved; // Close the reader before restoration can remove this file on Windows.
}
void recoverRouting(Routing& route, IMMDeviceEnumerator* devices, IMMDevice* device, const wchar_t* endpoint) {
  auto file = recoveryFile();
  if (!std::filesystem::exists(file)) return;
  const auto saved = readRecoveryFile(file);
  // A journal for another output must never restore this endpoint's mute state.
  const auto original = resolveEndpoint(devices, saved.endpoint.c_str());
  if (endpointIdentity(original.Get()).id != endpoint) throw E_INVALIDARG;
  checkDedicatedDefaults(devices, endpoint);
  for (int r = 0; r < 2; r++) {
    HSTRING id; check(WindowsCreateString(saved.previous[r].c_str(), static_cast<UINT32>(saved.previous[r].size()), &id));
    HRESULT hr = route.policy->SetEndpoint(route.pid, eRender, static_cast<ERole>(r), id);
    WindowsDeleteString(id); check(hr);
  }
  ComPtr<IAudioEndpointVolume> volume; check(device->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL, nullptr, &volume));
  check(volume->SetMute(saved.muted == L"1", nullptr));
  std::filesystem::remove(file);
  std::cerr << "RECOVERED" << std::endl;
}
struct AudioLease {
  EndpointMute mute;
  Routing route;
  AudioLease(DWORD root, IMMDeviceEnumerator* devices, IMMDevice* device, const wchar_t* endpoint) : route(root) {
    recoverRouting(route, devices, device, endpoint); route.snapshot();
    ComPtr<IAudioEndpointVolume> volume; check(device->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL, nullptr, &volume));
    BOOL before; check(volume->GetMute(&before));
    // Save the original settings before changing persistent Windows app routing.
    std::wofstream journal(recoveryFile(), std::ios::trunc);
    journal << endpoint << L'\n' << (before ? L"1" : L"0") << L'\n';
    for (auto value : route.before) journal << WindowsGetStringRawBuffer(value, nullptr) << L'\n';
    journal.close(); if (!journal) throw E_FAIL;
    mute.apply(device); route.apply(endpoint);
  }
  ~AudioLease() {
    HRESULT routing = route.restore(), muting = mute.restore();
    if (SUCCEEDED(routing) && SUCCEEDED(muting)) {
      std::error_code error; std::filesystem::remove(recoveryFile(), error);
      std::cerr << (error ? "RESTORE_PENDING" : "RESTORED") << std::endl;
    } else std::cerr << "RESTORE_PENDING" << std::endl;
  }
};
