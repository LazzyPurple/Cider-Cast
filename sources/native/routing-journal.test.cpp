#define wmain capture_main_unused
#include "capture.cpp"
#undef wmain
#include <cassert>
int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 2;
  const std::filesystem::path file(argv[1]);
  assert(!std::filesystem::exists(file));
  const wchar_t* endpoint = L"{0.0.0.00000000}.{1c8b198c-91d0-42b5-bec5-e30d15e7338e}";
  const std::wstring full = L"\\\\?\\SWD#MMDEVAPI#" + std::wstring(endpoint) + L"#{e6327cad-dcec-4949-ae8a-991e976a79d2}";
  for (const std::wstring previous : {std::wstring(), full}) {
    { std::wofstream out(file); out << endpoint << L"\n0\n" << previous << L'\n' << previous << L'\n'; }
    const auto saved = readRecoveryFile(file, endpoint);
    assert(saved.muted == L"0" && saved.previous[0] == previous);
    assert(readRecoveryFile(file).endpoint == endpoint);
    bool mismatch = false;
    try { readRecoveryFile(file, L"other"); } catch (HRESULT hr) { mismatch = hr == E_INVALIDARG; }
    assert(mismatch);
    // Regression: an open wifstream prevents deletion on Windows.
    assert(std::filesystem::remove(file));
  }
  { std::wofstream out(file); out << endpoint << L"\n0\ninvalid-route\n\n"; }
  bool rejected = false;
  try { readRecoveryFile(file, endpoint); } catch (HRESULT hr) { rejected = hr == E_INVALIDARG; }
  assert(rejected); assert(std::filesystem::remove(file));
  for (const std::wstring contents : {std::wstring(L"invalid-endpoint\n0\n\n\n"), std::wstring(endpoint) + L"\n2\n\n\n", std::wstring(endpoint) + L"\n0\n\n\nextra\n", std::wstring(endpoint) + L"\n0\n"}) {
    { std::wofstream out(file); out << contents; }
    rejected = false; try { readRecoveryFile(file); } catch (HRESULT hr) { rejected = hr == E_INVALIDARG; }
    assert(rejected && std::filesystem::exists(file)); assert(std::filesystem::remove(file));
  }
  std::cout << "Recovery journal validation and deletion: PASS (no audio APIs called)\n";
}
