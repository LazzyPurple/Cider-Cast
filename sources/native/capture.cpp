#define NOMINMAX
#include <windows.h>
#include <tlhelp32.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <endpointvolume.h>
#include <functiondiscoverykeys_devpkey.h>
#include <wrl.h>
#include <iostream>
#include <vector>
#include <set>
#include <map>
#include <string>
#include <cmath>
#include <algorithm>
#include <filesystem>
#include <future>
#include <avrt.h>
using namespace Microsoft::WRL;
void check(HRESULT hr) { if (FAILED(hr)) throw hr; }
bool parentAlive() {
  DWORD available = 0;
  return PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr) != FALSE;
}
ULONGLONG processCreatedAt(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return 0;
  FILETIME created{}, exited{}, kernel{}, user{};
  bool readable = GetProcessTimes(process, &created, &exited, &kernel, &user) != FALSE;
  CloseHandle(process);
  return readable ? (static_cast<ULONGLONG>(created.dwHighDateTime) << 32) | created.dwLowDateTime : 0;
}
template<class CreatedAt>
std::set<DWORD> descendantProcesses(DWORD root, const std::vector<PROCESSENTRY32W>& entries, CreatedAt createdAt) {
  std::set<DWORD> owned{root};
  std::map<DWORD, ULONGLONG> created{{root, createdAt(root)}};
  if (!created[root]) throw HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED);
  bool changed;
  do {
    changed = false;
    for (const auto& p : entries) if (owned.count(p.th32ParentProcessID) && !owned.count(p.th32ProcessID)) {
      if (!created.count(p.th32ProcessID)) created[p.th32ProcessID] = createdAt(p.th32ProcessID);
      // Parent IDs can be reused: a real child cannot predate this parent's current process.
      if (created[p.th32ProcessID] && created[p.th32ProcessID] >= created[p.th32ParentProcessID]) {
        owned.insert(p.th32ProcessID); changed = true;
      }
    }
  } while (changed);
  return owned;
}
bool isCiderImage(const std::wstring& image) {
  const std::filesystem::path executable(image), folder = executable.parent_path(), package = folder.parent_path();
  if (_wcsicmp(executable.filename().c_str(), L"Cider.exe") ||
      (_wcsicmp(folder.filename().c_str(), L"C2Windows") && _wcsicmp(folder.filename().c_str(), L"Cider")) ||
      _wcsicmp(package.parent_path().filename().c_str(), L"WindowsApps")) return false;
  const auto name = package.filename().wstring();
  const std::wstring prefix = L"CiderCollective.Cider_", publisher = L"__a6qxe093bx5xj";
  return name.size() > prefix.size() + publisher.size() &&
    !_wcsnicmp(name.c_str(), prefix.c_str(), prefix.size()) &&
    !_wcsicmp(name.c_str() + name.size() - publisher.size(), publisher.c_str());
}
std::set<DWORD> ciderProcesses(DWORD* root = nullptr) {
  std::vector<PROCESSENTRY32W> entries;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) throw HRESULT_FROM_WIN32(GetLastError());
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry)) do { entries.push_back(entry); } while (Process32NextW(snapshot, &entry));
  CloseHandle(snapshot);
  std::set<DWORD> owned;
  for (const auto& p : entries) if (!_wcsicmp(p.szExeFile, L"Cider.exe")) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, p.th32ProcessID);
    if (!process) continue;
    wchar_t buffer[32768]; DWORD length = 32768;
    if (QueryFullProcessImageNameW(process, 0, buffer, &length)) {
      std::wstring image(buffer, length);
      if (isCiderImage(image)) owned.insert(p.th32ProcessID);
    }
    CloseHandle(process);
  }
  if (owned.size() != 1) throw HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
  if (root) *root = *owned.begin();
  return descendantProcesses(*owned.begin(), entries, processCreatedAt);
}
bool eligibleAudioSession(DWORD pid, DWORD root, bool owned, AudioSessionState state, bool requireSignal, float peak) {
  // An active WebView session can be silent before the music process is created.
  return pid != root && owned && state == AudioSessionStateActive && (!requireSignal || (std::isfinite(peak) && peak > 0.00001f));
}
DWORD audioProcess(IMMDevice* device, bool requireSignal = false, DWORD requiredPid = 0) {
  DWORD root; auto owned = ciderProcesses(&root);
  ComPtr<IAudioSessionManager2> manager;
  check(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, &manager));
  ComPtr<IAudioSessionEnumerator> sessions; check(manager->GetSessionEnumerator(&sessions));
  int count; check(sessions->GetCount(&count));
  std::set<DWORD> matches;
  for (int i = 0; i < count; i++) {
    ComPtr<IAudioSessionControl> control; check(sessions->GetSession(i, &control));
    AudioSessionState state; check(control->GetState(&state));
    ComPtr<IAudioSessionControl2> control2; check(control.As(&control2));
    DWORD pid; check(control2->GetProcessId(&pid));
    // Cider.exe owns a metadata session; the music lives in its WebView child.
    float peak = 0;
    if (requireSignal && pid != root && owned.count(pid) && state == AudioSessionStateActive) {
      ComPtr<IAudioMeterInformation> meter;
      if (SUCCEEDED(control.As(&meter))) meter->GetPeakValue(&peak);
    }
    if ((!requiredPid || pid == requiredPid) && eligibleAudioSession(pid, root, owned.count(pid) != 0, state, requireSignal, peak)) matches.insert(pid);
  }
  if (matches.size() > 1) throw HRESULT_FROM_WIN32(ERROR_DUP_NAME);
  return matches.empty() ? 0 : *matches.begin();
}
bool capturedSessionHasSignal(IMMDevice* device, DWORD expectedPid) {
  ComPtr<IAudioSessionManager2> manager; check(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, &manager));
  ComPtr<IAudioSessionEnumerator> sessions; check(manager->GetSessionEnumerator(&sessions));
  int count; check(sessions->GetCount(&count));
  for (int i = 0; i < count; i++) {
    ComPtr<IAudioSessionControl> control; check(sessions->GetSession(i, &control));
    ComPtr<IAudioSessionControl2> control2; check(control.As(&control2));
    DWORD pid; check(control2->GetProcessId(&pid));
    if (pid != expectedPid) continue;
    AudioSessionState state; check(control->GetState(&state));
    ComPtr<IAudioMeterInformation> meter; float peak = 0;
    if (state == AudioSessionStateActive && SUCCEEDED(control.As(&meter)) && SUCCEEDED(meter->GetPeakValue(&peak)) && std::isfinite(peak) && peak > 0.00001f) return true;
  }
  return false;
}
std::pair<DWORD, ULONGLONG> probeAudioSource(const std::wstring& endpoint, DWORD pid) {
  const auto started = GetTickCount64();
  check(RoInitialize(RO_INIT_MULTITHREADED));
  DWORD replacement = 0;
  try {
    ComPtr<IMMDeviceEnumerator> devices; check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&devices)));
    ComPtr<IMMDevice> device; check(devices->GetDevice(endpoint.c_str(), &device));
    if (!capturedSessionHasSignal(device.Get(), pid)) replacement = audioProcess(device.Get(), true);
  } catch (...) { RoUninitialize(); throw; }
  RoUninitialize(); return {replacement, GetTickCount64() - started};
}
bool sourceProbeDue(ULONGLONG now, ULONGLONG nextCheck, ULONGLONG lastSignal, bool pending) {
  return !pending && now >= nextCheck && now - lastSignal >= 1000;
}
bool pollSourceProbe(std::future<std::pair<DWORD, ULONGLONG>>& pending, std::pair<DWORD, ULONGLONG>& result) {
  if (!pending.valid() || pending.wait_for(std::chrono::milliseconds(0)) != std::future_status::ready) return false;
  result = pending.get(); return true;
}
struct AudioThreadPriority {
  DWORD index = 0;
  HANDLE task = AvSetMmThreadCharacteristicsW(L"Audio", &index);
  ~AudioThreadPriority() { if (task) AvRevertMmThreadCharacteristics(task); }
};
class Activation : public RuntimeClass<RuntimeClassFlags<ClassicCom>, IActivateAudioInterfaceCompletionHandler, FtmBase> {
public:
  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HRESULT result = E_PENDING;
  ComPtr<IAudioClient> audio;
  ~Activation() { CloseHandle(ready); }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    ComPtr<IUnknown> object; HRESULT activationResult = E_FAIL;
    result = operation->GetActivateResult(&activationResult, &object);
    if (SUCCEEDED(result)) result = activationResult;
    if (SUCCEEDED(result)) result = object.As(&audio);
    SetEvent(ready); return S_OK;
  }
};
struct EndpointMute {
  ComPtr<IAudioEndpointVolume> volume;
  BOOL before = FALSE;
  bool changed = false;
  HRESULT restore() { if (!changed) return S_OK; HRESULT hr = volume->SetMute(before, nullptr); if (SUCCEEDED(hr)) changed = false; return hr; }
  ~EndpointMute() { restore(); }
  void apply(IMMDevice* device) {
    check(device->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL, nullptr, &volume));
    check(volume->GetMute(&before)); check(volume->SetMute(TRUE, nullptr)); changed = true;
  }
};
#include "endpoint.h"
#include "routing.h"
int wmain(int argc, wchar_t** argv) {
  bool recoverOnly = argc == 3 && !wcscmp(argv[2], L"--restore");
  bool inspectOnly = argc == 3 && !wcscmp(argv[2], L"--inspect");
  bool listOnly = argc == 3 && !wcscmp(argv[2], L"--outputs");
  if ((argc != 2 && !recoverOnly && !inspectOnly && !listOnly) || wcslen(argv[1]) > 100) return 2;
  if (recoverOnly && !std::filesystem::exists(recoveryFile())) return 0;
  HRESULT initialized = RoInitialize(RO_INIT_MULTITHREADED);
  if (FAILED(initialized)) return 3;
  HANDLE samples = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HANDLE process = nullptr;
  HANDLE rootProcess = nullptr;
  HANDLE lock = nullptr; bool ownsLock = false;
  int exitCode = 0;
  auto stage = [](const char* name) { std::cerr << "STAGE " << name << std::endl; };
  try {
    if (listOnly) {
      ComPtr<IMMDeviceEnumerator> devices; check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&devices)));
      writeOutputList(devices.Get(), argv[1]);
      throw HRESULT_FROM_WIN32(ERROR_CANCELLED);
    }
    lock = CreateMutexW(nullptr, FALSE, L"Local\\CiderMarshallAudioRoute");
    if (!lock) throw HRESULT_FROM_WIN32(GetLastError());
    DWORD acquired = WaitForSingleObject(lock, 0);
    ownsLock = acquired == WAIT_OBJECT_0 || acquired == WAIT_ABANDONED;
    if (!ownsLock) throw HRESULT_FROM_WIN32(ERROR_BUSY);
    stage("endpoint");
    ComPtr<IMMDeviceEnumerator> devices; check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&devices)));
    ComPtr<IMMDevice> device = resolveEndpoint(devices.Get(), argv[1]);
    const auto endpoint = endpointIdentity(device.Get()).id;
    stage("cider");
    DWORD root; ciderProcesses(&root);
    rootProcess = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, root);
    if (!rootProcess) throw HRESULT_FROM_WIN32(GetLastError());
    if (inspectOnly) {
      Routing probe(root);
      std::cout << "POLICY_READABLE 1\nJOURNAL_PRESENT " << std::filesystem::exists(recoveryFile()) << '\n';
      for (ERole role : {eConsole, eMultimedia, eCommunications}) {
        ComPtr<IMMDevice> main; check(devices->GetDefaultAudioEndpoint(eRender, role, &main));
        LPWSTR id = nullptr; check(main->GetId(&id));
        std::cout << "LG_IS_DEFAULT_ROLE " << role << ' ' << (endpoint == id) << '\n'; CoTaskMemFree(id);
      }
      ComPtr<IMMDeviceCollection> outputs; check(devices->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &outputs));
      UINT count; check(outputs->GetCount(&count));
      for (UINT i = 0; i < count; i++) { ComPtr<IMMDevice> output; check(outputs->Item(i, &output)); DWORD selected = audioProcess(output.Get(), true); if (selected) std::cout << "SELECTABLE " << selected << '\n'; }
      throw HRESULT_FROM_WIN32(ERROR_CANCELLED);
    }
    stage("default-check");
    checkDedicatedDefaults(devices.Get(), endpoint);
    stage("recovery");
    { Routing recovery(root); recoverRouting(recovery, devices.Get(), device.Get(), endpoint.c_str()); }
    if (recoverOnly) throw HRESULT_FROM_WIN32(ERROR_CANCELLED);
    auto checkDefaults = [&]() {
    stage("default-check");
    checkDedicatedDefaults(devices.Get(), endpoint);
    };
    checkDefaults();
    stage("selection");
    std::set<DWORD> candidates;
    while (true) {
      candidates.clear();
      ComPtr<IMMDeviceCollection> endpoints; check(devices->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &endpoints));
      UINT endpointCount; check(endpoints->GetCount(&endpointCount));
      for (UINT i = 0; i < endpointCount; i++) { ComPtr<IMMDevice> output; check(endpoints->Item(i, &output)); DWORD selected = audioProcess(output.Get(), true); if (selected) candidates.insert(selected); }
      if (candidates.size() == 1) break;
      if (candidates.size() > 1) throw HRESULT_FROM_WIN32(ERROR_DUP_NAME);
      if (!parentAlive() || WaitForSingleObject(rootProcess, 0) != WAIT_TIMEOUT) throw HRESULT_FROM_WIN32(ERROR_CANCELLED);
      Sleep(250);
    }
    if (!parentAlive() || WaitForSingleObject(rootProcess, 0) != WAIT_TIMEOUT) throw HRESULT_FROM_WIN32(ERROR_CANCELLED);
    checkDefaults(); // The dedicated endpoint may have become a default while waiting.
    if (endpointInUse(device.Get())) throw HRESULT_FROM_WIN32(ERROR_BUSY);
    DWORD pid = *candidates.begin();
    stage("route");
    AudioLease lease(root, devices.Get(), device.Get(), endpoint.c_str());
    std::cerr << "READY" << std::endl;
    stage("wait-route");
    ULONGLONG deadline = GetTickCount64() + 5000;
    while (parentAlive() && audioProcess(device.Get(), false, pid) != pid && GetTickCount64() < deadline) Sleep(100);
    if (!parentAlive()) throw HRESULT_FROM_WIN32(ERROR_CANCELLED);
    if (audioProcess(device.Get(), false, pid) != pid) throw HRESULT_FROM_WIN32(WAIT_TIMEOUT);
    std::cerr << "CAPTURE " << pid << std::endl;
    // Keep the same routing lease if WebView replaces its audio child between tracks.
    while (parentAlive() && WaitForSingleObject(rootProcess, 0) == WAIT_TIMEOUT) {
    {
    stage("activate");
    auto callback = Make<Activation>();
    AUDIOCLIENT_ACTIVATION_PARAMS params{}; params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT value{}; value.vt = VT_BLOB; value.blob.cbSize = sizeof(params); value.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    check(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &value, callback.Get(), &operation));
    if (WaitForSingleObject(callback->ready, 10000) != WAIT_OBJECT_0) throw HRESULT_FROM_WIN32(WAIT_TIMEOUT);
    check(callback->result);
    stage("initialize");
    WAVEFORMATEX format{}; format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT; format.nChannels = 2; format.nSamplesPerSec = 48000;
    format.wBitsPerSample = 32; format.nBlockAlign = 8; format.nAvgBytesPerSec = 384000;
    check(callback->audio->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, 0, 0, &format, nullptr));
    check(callback->audio->SetEventHandle(samples));
    ComPtr<IAudioCaptureClient> capture; check(callback->audio->GetService(IID_PPV_ARGS(&capture)));
    AudioThreadPriority priority;
    check(callback->audio->Start());
    process = OpenProcess(SYNCHRONIZE, FALSE, pid);
    if (!process) throw HRESULT_FROM_WIN32(GetLastError());
    stage("capture");
    std::vector<float> buffer;
    UINT64 capturedFrames = 0, discontinuities = 0, timestampErrors = 0, missingFrames = 0, expectedPosition = 0;
    bool havePosition = false;
    ULONGLONG maxProbeMs = 0, maxWriteMs = 0, nextMetrics = GetTickCount64() + 1000;
    ULONGLONG nextSessionCheck = GetTickCount64() + 1000;
    ULONGLONG lastSignal = GetTickCount64(), lastPacket = 0, maxPacketGapMs = 0, maxPacketAgeMs = 0, qpcPackets = 0;
    LARGE_INTEGER frequency{}; check(QueryPerformanceFrequency(&frequency) ? S_OK : HRESULT_FROM_WIN32(GetLastError()));
    std::future<std::pair<DWORD, ULONGLONG>> sourceProbe;
    while (parentAlive() && WaitForSingleObject(process, 0) == WAIT_TIMEOUT && WaitForSingleObject(rootProcess, 0) == WAIT_TIMEOUT) {
      std::pair<DWORD, ULONGLONG> result{}; bool probeReady = false;
      try { probeReady = pollSourceProbe(sourceProbe, result); }
      catch (HRESULT hr) { if (hr != HRESULT_FROM_WIN32(ERROR_DUP_NAME)) throw; probeReady = true; }
      if (probeReady) {
        maxProbeMs = std::max(maxProbeMs, result.second);
        nextSessionCheck = GetTickCount64() + 1000;
        if (result.first && result.first != pid && GetTickCount64() - lastSignal >= 1000) break;
      }
      // The verified process handle pins this source; never enumerate COM sessions on the audio thread.
      if (sourceProbeDue(GetTickCount64(), nextSessionCheck, lastSignal, sourceProbe.valid())) {
        sourceProbe = std::async(std::launch::async, probeAudioSource, endpoint, pid);
      }
      WaitForSingleObject(samples, 100);
      UINT32 count = 0; check(capture->GetNextPacketSize(&count));
      while (count) {
        BYTE* data = nullptr; DWORD flags = 0; UINT64 position = 0, qpc = 0;
        check(capture->GetBuffer(&data, &count, &flags, &position, &qpc));
        const auto packetAt = GetTickCount64();
        if (lastPacket) maxPacketGapMs = std::max(maxPacketGapMs, packetAt - lastPacket);
        lastPacket = packetAt;
        if (qpc && !(flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR)) {
          LARGE_INTEGER now{};
          if (QueryPerformanceCounter(&now)) {
            const double age = static_cast<double>(now.QuadPart) * 1000.0 / frequency.QuadPart - static_cast<double>(qpc) / 10000.0;
            if (std::isfinite(age) && age >= 0 && age < 86400000) { maxPacketAgeMs = std::max(maxPacketAgeMs, static_cast<ULONGLONG>(age)); qpcPackets++; }
          }
        }
        capturedFrames += count;
        if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) discontinuities++;
        if (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) timestampErrors++;
        else {
          if (havePosition && position > expectedPosition) missingFrames += position - expectedPosition;
          expectedPosition = position + count; havePosition = true;
        }
        buffer.assign(count * 2, 0);
        if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
          const float* values = reinterpret_cast<float*>(data);
          bool hasSignal = false;
          for (UINT32 i = 0; i < count * 2; i++) { buffer[i] = std::isfinite(values[i]) ? std::clamp(values[i], -1.f, 1.f) : 0; hasSignal |= std::abs(buffer[i]) > .00001f; }
          if (hasSignal) lastSignal = packetAt;
        }
        check(capture->ReleaseBuffer(count));
        DWORD bytes = static_cast<DWORD>(buffer.size() * sizeof(float)), offset = 0;
        const auto writeAt = GetTickCount64();
        while (offset < bytes) { DWORD written = 0; if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), reinterpret_cast<BYTE*>(buffer.data()) + offset, bytes - offset, &written, nullptr)) throw HRESULT_FROM_WIN32(GetLastError()); offset += written; }
        maxWriteMs = std::max(maxWriteMs, GetTickCount64() - writeAt);
        check(capture->GetNextPacketSize(&count));
      }
      if (GetTickCount64() >= nextMetrics) {
        std::cerr << "CAPTURE_STATS " << capturedFrames << ' ' << discontinuities << ' ' << timestampErrors << ' ' << missingFrames << ' ' << maxProbeMs << ' ' << maxWriteMs << std::endl;
        std::cerr << "CAPTURE_TIMING " << maxPacketGapMs << ' ' << maxPacketAgeMs << ' ' << qpcPackets << ' ' << !!priority.task << std::endl;
        nextMetrics = GetTickCount64() + 1000;
      }
    }
    check(callback->audio->Stop());
    }
    if (process) { CloseHandle(process); process = nullptr; }
    if (!parentAlive() || WaitForSingleObject(rootProcess, 0) != WAIT_TIMEOUT) break;
    std::cerr << "SOURCE_WAIT" << std::endl;
    stage("source-wait");
    pid = 0;
    const float silence[1920]{};
    ULONGLONG nextProbe = 0, nextSilence = GetTickCount64();
    while (parentAlive() && WaitForSingleObject(rootProcess, 0) == WAIT_TIMEOUT && !pid) {
      const auto now = GetTickCount64();
      if (now >= nextProbe) { pid = audioProcess(device.Get(), true); nextProbe = now + 250; }
      if (pid) break;
      if (now >= nextSilence) {
        DWORD written = 0;
        if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), silence, sizeof(silence), &written, nullptr) || written != sizeof(silence)) throw HRESULT_FROM_WIN32(ERROR_BROKEN_PIPE);
        nextSilence = now + 20;
      }
      Sleep(5);
    }
    if (pid) std::cerr << "CAPTURE " << pid << std::endl;
    }
  } catch (HRESULT hr) { if (hr != HRESULT_FROM_WIN32(ERROR_CANCELLED)) { std::cerr << "ERROR 0x" << std::hex << hr << std::endl; exitCode = 1; } }
  catch (const std::exception&) { std::cerr << "ERROR recovery-file" << std::endl; exitCode = 1; }
  if (process) CloseHandle(process);
  if (rootProcess) CloseHandle(rootProcess);
  if (ownsLock) ReleaseMutex(lock);
  if (lock) CloseHandle(lock);
  CloseHandle(samples); RoUninitialize(); return exitCode;
}
