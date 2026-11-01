struct EndpointIdentity {
  std::wstring id, name;
  GUID container{};
  DWORD state = 0;
};
bool isDedicatedEndpoint(const EndpointIdentity& value) {
  return !value.id.empty() && !value.name.empty();
}
bool sameEndpointHardware(const EndpointIdentity& first, const EndpointIdentity& second) {
  return isDedicatedEndpoint(first) && first.name == second.name &&
    first.container != GUID_NULL && first.container == second.container;
}
size_t selectEndpoint(const EndpointIdentity& preferred, const std::vector<EndpointIdentity>& candidates) {
  if (!isDedicatedEndpoint(preferred)) throw E_INVALIDARG;
  if (preferred.state == DEVICE_STATE_DISABLED) throw E_ACCESSDENIED;
  for (size_t i = 0; i < candidates.size(); ++i)
    if (candidates[i].state == DEVICE_STATE_ACTIVE && candidates[i].id == preferred.id) return i;
  size_t selected = candidates.size();
  for (size_t i = 0; i < candidates.size(); ++i) {
    if (candidates[i].state != DEVICE_STATE_ACTIVE) continue;
    if (!sameEndpointHardware(preferred, candidates[i])) continue;
    if (selected != candidates.size()) throw HRESULT_FROM_WIN32(ERROR_DUP_NAME);
    selected = i;
  }
  if (selected == candidates.size()) throw HRESULT_FROM_WIN32(ERROR_DEVICE_NOT_CONNECTED);
  return selected;
}
EndpointIdentity endpointIdentity(IMMDevice* device) {
  EndpointIdentity value;
  LPWSTR id = nullptr; check(device->GetId(&id)); value.id = id; CoTaskMemFree(id);
  check(device->GetState(&value.state));
  ComPtr<IPropertyStore> properties; check(device->OpenPropertyStore(STGM_READ, &properties));
  PROPVARIANT property{};
  check(properties->GetValue(PKEY_Device_FriendlyName, &property));
  if (property.vt == VT_LPWSTR && property.pwszVal) value.name = property.pwszVal;
  PropVariantClear(&property);
  if (SUCCEEDED(properties->GetValue(PKEY_Device_ContainerId, &property)) && property.vt == VT_CLSID && property.puuid) value.container = *property.puuid;
  PropVariantClear(&property);
  return value;
}
ComPtr<IMMDevice> resolveEndpoint(IMMDeviceEnumerator* devices, const wchar_t* preferredId) {
  ComPtr<IMMDevice> preferred; check(devices->GetDevice(preferredId, &preferred));
  const auto identity = endpointIdentity(preferred.Get());
  if (!isDedicatedEndpoint(identity)) throw E_INVALIDARG;
  if (identity.state == DEVICE_STATE_ACTIVE) return preferred;
  ComPtr<IMMDeviceCollection> active; check(devices->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &active));
  UINT count; check(active->GetCount(&count));
  std::vector<ComPtr<IMMDevice>> outputs;
  std::vector<EndpointIdentity> candidates;
  for (UINT i = 0; i < count; ++i) {
    ComPtr<IMMDevice> output; check(active->Item(i, &output));
    candidates.push_back(endpointIdentity(output.Get())); outputs.push_back(output);
  }
  return outputs[selectEndpoint(identity, candidates)];
}
void checkDedicatedDefaults(IMMDeviceEnumerator* devices, const std::wstring& endpoint) {
  for (ERole role : {eConsole, eMultimedia, eCommunications}) {
    ComPtr<IMMDevice> main; check(devices->GetDefaultAudioEndpoint(eRender, role, &main));
    LPWSTR id = nullptr; check(main->GetId(&id)); const bool same = endpoint == id; CoTaskMemFree(id);
    if (same) throw E_ACCESSDENIED;
  }
}
bool endpointInUse(IMMDevice* device) {
  ComPtr<IAudioSessionManager2> manager; check(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, &manager));
  ComPtr<IAudioSessionEnumerator> sessions; check(manager->GetSessionEnumerator(&sessions));
  int count; check(sessions->GetCount(&count));
  for (int i = 0; i < count; ++i) {
    ComPtr<IAudioSessionControl> session; check(sessions->GetSession(i, &session));
    AudioSessionState state; check(session->GetState(&state));
    if (state == AudioSessionStateActive) return true;
  }
  return false;
}
void writeJsonString(const std::wstring& value) {
  static const char* hex = "0123456789abcdef";
  std::cout << '"';
  for (wchar_t ch : value) {
    std::cout << "\\u" << hex[(ch >> 12) & 15] << hex[(ch >> 8) & 15] << hex[(ch >> 4) & 15] << hex[ch & 15];
  }
  std::cout << '"';
}
void writeOutputList(IMMDeviceEnumerator* devices, const wchar_t* preferred) {
  std::wstring selected;
  try { selected = endpointIdentity(resolveEndpoint(devices, preferred).Get()).id; } catch (HRESULT) { }
  ComPtr<IMMDeviceCollection> active; check(devices->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &active));
  UINT count; check(active->GetCount(&count));
  if (count > 64) throw E_INVALIDARG;
  std::cout << '[';
  for (UINT i = 0; i < count; ++i) {
    ComPtr<IMMDevice> output; check(active->Item(i, &output)); const auto identity = endpointIdentity(output.Get());
    bool isDefault = false;
    try { checkDedicatedDefaults(devices, identity.id); } catch (HRESULT hr) { if (hr != E_ACCESSDENIED) throw; isDefault = true; }
    if (i) std::cout << ',';
    std::cout << "{\"id\":"; writeJsonString(identity.id);
    std::cout << ",\"name\":"; writeJsonString(identity.name);
    std::cout << ",\"isDefault\":" << (isDefault ? "true" : "false") << ",\"inUse\":" << (endpointInUse(output.Get()) ? "true" : "false")
      << ",\"selected\":" << (selected == identity.id ? "true" : "false") << '}';
  }
  std::cout << "]\n";
}
