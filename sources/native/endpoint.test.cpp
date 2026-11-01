#define wmain unused_capture_main
#include "capture.cpp"
#undef wmain
#include <cassert>
#include <sstream>
int wmain(int argc, wchar_t** argv) {
  if (argc == 3 && !wcscmp(argv[1], L"--resolve")) {
    check(RoInitialize(RO_INIT_MULTITHREADED));
    try {
      ComPtr<IMMDeviceEnumerator> devices; check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&devices)));
      ComPtr<IMMDevice> old; check(devices->GetDevice(argv[2], &old));
      const auto before = endpointIdentity(old.Get());
      const auto resolved = resolveEndpoint(devices.Get(), argv[2]); const auto after = endpointIdentity(resolved.Get());
      checkDedicatedDefaults(devices.Get(), after.id);
      std::cout << "RESOLVED_ACTIVE " << (after.state == DEVICE_STATE_ACTIVE) << " SAME_HARDWARE " << sameEndpointHardware(before, after)
        << " CHANGED_ID " << (before.id != after.id) << '\n';
    } catch (HRESULT hr) { std::cerr << "RESOLVE_ERROR 0x" << std::hex << hr << '\n'; RoUninitialize(); return 1; }
    RoUninitialize(); return 0;
  }
  const GUID hardware = {1,2,3,{4,5,6,7,8,9,10,11}};
  const EndpointIdentity old{L"old",L"Dedicated output",hardware,DEVICE_STATE_NOTPRESENT};
  const EndpointIdentity fresh{L"new",old.name,hardware,DEVICE_STATE_ACTIVE};
  auto rejected = [&](const EndpointIdentity& preferred, const std::vector<EndpointIdentity>& values, HRESULT expected) {
    bool failed = false; try { selectEndpoint(preferred, values); } catch (HRESULT hr) { failed = hr == expected; } assert(failed);
  };
  assert(selectEndpoint(old,{fresh}) == 0);
  auto exact = old; exact.state = DEVICE_STATE_ACTIVE;
  assert(selectEndpoint(old,{fresh,fresh,exact}) == 2);
  rejected(old,{},HRESULT_FROM_WIN32(ERROR_DEVICE_NOT_CONNECTED));
  rejected(old,{fresh,fresh},HRESULT_FROM_WIN32(ERROR_DUP_NAME));
  auto wrong = fresh; wrong.name = L"Other output";
  rejected(old,{wrong},HRESULT_FROM_WIN32(ERROR_DEVICE_NOT_CONNECTED));
  wrong = fresh; wrong.container.Data1++;
  rejected(old,{wrong},HRESULT_FROM_WIN32(ERROR_DEVICE_NOT_CONNECTED));
  auto missing = old; missing.container = GUID_NULL; wrong = fresh; wrong.container = GUID_NULL;
  rejected(missing,{wrong},HRESULT_FROM_WIN32(ERROR_DEVICE_NOT_CONNECTED));
  auto disabled = old; disabled.state = DEVICE_STATE_DISABLED;
  rejected(disabled,{fresh},E_ACCESSDENIED);
  wrong = fresh; wrong.state = DEVICE_STATE_UNPLUGGED;
  rejected(old,{wrong},HRESULT_FROM_WIN32(ERROR_DEVICE_NOT_CONNECTED));
  std::ostringstream json; auto original = std::cout.rdbuf(json.rdbuf());
  writeJsonString(L"Sortie \"USB\" \\ \n é"); std::cout.rdbuf(original);
  assert(json.str().find("\\u0022") != std::string::npos && json.str().find("\\u005c") != std::string::npos && json.str().find("\\u000a") != std::string::npos);
  std::cout << "PASS: endpoint replacement, exact preference, ambiguity, identity, disabled, missing and JSON escaping (no routing APIs called)\n";
}
