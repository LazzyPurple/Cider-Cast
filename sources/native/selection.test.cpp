#define wmain unused_capture_main
#include "capture.cpp"
#undef wmain
#include <cassert>
#include <limits>
int main(int argc, char** argv) {
  _set_error_mode(_OUT_TO_STDERR);
  if (argc == 2 && !strcmp(argv[1], "--mmcss")) {
    AudioThreadPriority priority;
    std::cout << "MMCSS_ACTIVE " << !!priority.task << '\n'; return priority.task ? 0 : 1;
  }
  assert(!sourceProbeDue(1000, 1000, 1, false));
  assert(sourceProbeDue(1001, 1000, 1, false));
  assert(!sourceProbeDue(1001, 1002, 0, false));
  assert(!sourceProbeDue(1001, 1000, 0, true));
  std::promise<std::pair<DWORD, ULONGLONG>> probeResult;
  auto pendingProbe = probeResult.get_future();
  std::pair<DWORD, ULONGLONG> result{};
  assert(!pollSourceProbe(pendingProbe, result));
  probeResult.set_value({123, 700});
  assert(pollSourceProbe(pendingProbe, result) && result.first == 123 && result.second == 700);
  assert(!pollSourceProbe(pendingProbe, result));
  std::promise<std::pair<DWORD, ULONGLONG>> failedProbe;
  auto failure = failedProbe.get_future();
  failedProbe.set_exception(std::make_exception_ptr(HRESULT_FROM_WIN32(ERROR_DUP_NAME)));
  bool ambiguous = false;
  try { pollSourceProbe(failure, result); } catch (HRESULT hr) { ambiguous = hr == HRESULT_FROM_WIN32(ERROR_DUP_NAME); }
  assert(ambiguous && !failure.valid());
  if (argc == 2 && !strcmp(argv[1], "--processes")) {
    try { DWORD root = 0; const auto owned = ciderProcesses(&root); std::cout << "VERIFIED_ROOT " << root << " OWNED_COUNT " << owned.size() << '\n'; return 0; }
    catch (HRESULT hr) { std::cerr << "IDENTITY_ERROR 0x" << std::hex << hr << '\n'; return 1; }
  }
  assert(isCiderImage(L"C:\\Program Files\\WindowsApps\\CiderCollective.Cider_4.0.31.0_x64__a6qxe093bx5xj\\C2Windows\\Cider.exe"));
  assert(isCiderImage(L"C:\\Program Files\\WindowsApps\\CiderCollective.Cider_4.0.32.0_x64__a6qxe093bx5xj\\Cider\\Cider.exe"));
  assert(isCiderImage(L"C:\\PROGRAM FILES\\WINDOWSAPPS\\CiderCollective.Cider_4.0.32.0_x64__a6qxe093bx5xj\\cider\\cider.exe"));
  assert(!isCiderImage(L"C:\\Other\\Cider\\Cider.exe"));
  assert(!isCiderImage(L"C:\\Program Files\\WindowsApps\\OtherApp_4.0.32.0_x64__a6qxe093bx5xj\\Cider\\Cider.exe"));
  assert(!isCiderImage(L"C:\\Program Files\\WindowsApps\\CiderCollective.Cider_4.0.32.0_x64__otherpublisher\\Cider\\Cider.exe"));
  assert(!isCiderImage(L"C:\\Program Files\\WindowsApps\\CiderCollective.Cider_4.0.32.0_x64__a6qxe093bx5xj\\Cider\\Cider.exe.bak"));
  assert(!isCiderImage(L"C:\\Program Files\\WindowsApps\\CiderCollective.Cider_4.0.32.0_x64__a6qxe093bx5xj\\Cider\\Cider.exe\\C2Windows\\Cider.exe"));
  // PID 11 now belongs to CiderNode, but an older unrelated process still names it as parent.
  const std::vector<PROCESSENTRY32W> entries = [] {
    std::vector<PROCESSENTRY32W> result;
    for (auto pair : {std::pair<DWORD, DWORD>{11, 10}, {12, 11}, {13, 11}, {14, 12}, {15, 11}, {16, 99}, {17, 13}}) {
      PROCESSENTRY32W entry{}; entry.th32ProcessID = pair.first; entry.th32ParentProcessID = pair.second; result.push_back(entry);
    }
    return result;
  }();
  const std::map<DWORD, ULONGLONG> created{{10, 100}, {11, 110}, {12, 20}, {13, 120}, {14, 130}, {15, 0}, {16, 140}, {17, 130}};
  const auto owned = descendantProcesses(10, entries, [&](DWORD pid) { return created.at(pid); });
  assert((owned == std::set<DWORD>{10, 11, 13, 17}));
  assert(!eligibleAudioSession(12, 10, owned.count(12) != 0, AudioSessionStateActive, true, .8f));
  bool denied = false;
  try { descendantProcesses(10, entries, [](DWORD) -> ULONGLONG { return 0; }); }
  catch (HRESULT hr) { denied = hr == HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED); }
  assert(denied);
  assert(recoveryFile().parent_path().parent_path().filename() == L"cider-marshall-isolated");
  assert(!eligibleAudioSession(10, 10, true, AudioSessionStateActive, true, 1));
  assert(!eligibleAudioSession(11, 10, false, AudioSessionStateActive, true, 1));
  assert(!eligibleAudioSession(11, 10, true, AudioSessionStateInactive, true, .5f));
  assert(!eligibleAudioSession(11, 10, true, AudioSessionStateActive, true, 0));
  assert(!eligibleAudioSession(11, 10, true, AudioSessionStateActive, true, std::numeric_limits<float>::quiet_NaN()));
  assert(eligibleAudioSession(12, 10, true, AudioSessionStateActive, true, .1f));
  // Once selected, a silent passage must not invalidate the route check.
  assert(eligibleAudioSession(12, 10, true, AudioSessionStateActive, false, 0));
  std::cout << "PASS: reused parent IDs excluded; valid descendants, silent, unrelated, inactive and metadata selection verified\n";
}
