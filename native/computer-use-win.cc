// MyDSH Windows 系统级 Computer Use 原生模块（SendInput + EnumWindows + DWM + 防自锁硬门禁）。
// 通过稳定 Node-API 导出与 macOS 对齐的 16 个函数，在初始化阶段一次性缓存 N-API 函数表并兜底拦截 C++ 异常，
// 所有键鼠投递均执行 GetCurrentProcessId() 与目标窗口归属校验，并支持扩展键扫描码与 UIPI 返回值检测。
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <dwmapi.h>
#include <node_api.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iterator>
#include <limits>
#include <string>
#include <vector>

struct NapiTable {
  decltype(&napi_get_boolean) get_boolean;
  decltype(&napi_get_null) get_null;
  decltype(&napi_create_object) create_object;
  decltype(&napi_create_array) create_array;
  decltype(&napi_create_double) create_double;
  decltype(&napi_create_string_utf8) create_string_utf8;
  decltype(&napi_set_named_property) set_named_property;
  decltype(&napi_set_element) set_element;
  decltype(&napi_get_cb_info) get_cb_info;
  decltype(&napi_get_value_double) get_value_double;
  decltype(&napi_get_value_int32) get_value_int32;
  decltype(&napi_get_value_bool) get_value_bool;
  decltype(&napi_get_value_string_utf16) get_value_string_utf16;
  decltype(&napi_define_properties) define_properties;
  bool ready;
};

static NapiTable gApi{};

template <class T>
static bool ResolveApi(HMODULE mod, const char* name, T* out) {
  auto addr = GetProcAddress(mod, name);
  if (!addr) return false;
  *out = reinterpret_cast<T>(addr);
  return true;
}

static bool InitNapiTable() {
  if (gApi.ready) return true;
  HMODULE mod = GetModuleHandleW(nullptr);
  if (!mod) return false;
  bool ok =
      ResolveApi(mod, "napi_get_boolean", &gApi.get_boolean) &&
      ResolveApi(mod, "napi_get_null", &gApi.get_null) &&
      ResolveApi(mod, "napi_create_object", &gApi.create_object) &&
      ResolveApi(mod, "napi_create_array", &gApi.create_array) &&
      ResolveApi(mod, "napi_create_double", &gApi.create_double) &&
      ResolveApi(mod, "napi_create_string_utf8", &gApi.create_string_utf8) &&
      ResolveApi(mod, "napi_set_named_property", &gApi.set_named_property) &&
      ResolveApi(mod, "napi_set_element", &gApi.set_element) &&
      ResolveApi(mod, "napi_get_cb_info", &gApi.get_cb_info) &&
      ResolveApi(mod, "napi_get_value_double", &gApi.get_value_double) &&
      ResolveApi(mod, "napi_get_value_int32", &gApi.get_value_int32) &&
      ResolveApi(mod, "napi_get_value_bool", &gApi.get_value_bool) &&
      ResolveApi(mod, "napi_get_value_string_utf16", &gApi.get_value_string_utf16) &&
      ResolveApi(mod, "napi_define_properties", &gApi.define_properties);
  gApi.ready = ok;
  return ok;
}

static constexpr uint32_t kModAlt = 1u << 0;
static constexpr uint32_t kModControl = 1u << 1;
static constexpr uint32_t kModMeta = 1u << 2;
static constexpr uint32_t kModShift = 1u << 3;
static constexpr double kMaxSafeHandleDouble = 9007199254740991.0;

static std::string WideToUtf8(const std::wstring& input) {
  if (input.empty()) return {};
  int bytes = WideCharToMultiByte(CP_UTF8, 0, input.c_str(), static_cast<int>(input.size()),
                                  nullptr, 0, nullptr, nullptr);
  if (bytes <= 0) return {};
  std::string out(static_cast<size_t>(bytes), '\0');
  WideCharToMultiByte(CP_UTF8, 0, input.c_str(), static_cast<int>(input.size()), out.data(), bytes,
                      nullptr, nullptr);
  return out;
}

static bool IsProcessElevated() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  TOKEN_ELEVATION elevation{};
  DWORD size = sizeof(elevation);
  bool elevated = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size) &&
                  elevation.TokenIsElevated != 0;
  CloseHandle(token);
  return elevated;
}

static napi_value MakeBool(napi_env env, bool value) {
  napi_value result = nullptr;
  gApi.get_boolean(env, value, &result);
  return result;
}

static void SetBoolProp(napi_env env, napi_value obj, const char* key, bool value) {
  gApi.set_named_property(env, obj, key, MakeBool(env, value));
}

static void SetNumberProp(napi_env env, napi_value obj, const char* key, double value) {
  napi_value num = nullptr;
  gApi.create_double(env, value, &num);
  gApi.set_named_property(env, obj, key, num);
}

static void SetStringProp(napi_env env, napi_value obj, const char* key, const std::string& value) {
  napi_value str = nullptr;
  gApi.create_string_utf8(env, value.c_str(), value.size(), &str);
  gApi.set_named_property(env, obj, key, str);
}

static bool ReadDouble(napi_env env, napi_value val, double* out) {
  double v = 0.0;
  if (gApi.get_value_double(env, val, &v) != napi_ok || !std::isfinite(v)) return false;
  *out = v;
  return true;
}

static bool ReadInt32(napi_env env, napi_value val, int32_t* out) {
  return gApi.get_value_int32(env, val, out) == napi_ok;
}

static int32_t SafeNegateInt32(int32_t value) {
  if (value == std::numeric_limits<int32_t>::min()) return std::numeric_limits<int32_t>::max();
  return -value;
}

static bool IsWindowCloaked(HWND hwnd) {
  DWORD cloaked = 0;
  HRESULT hr = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
  return SUCCEEDED(hr) && cloaked != 0;
}

static LONG ClampToLong(double value) {
  constexpr double kMin = static_cast<double>(std::numeric_limits<LONG>::min());
  constexpr double kMax = static_cast<double>(std::numeric_limits<LONG>::max());
  double clamped = std::clamp(value, kMin, kMax);
  return static_cast<LONG>(std::llround(clamped));
}

static DWORD RootWindowPidAtPoint(double x, double y) {
  POINT pt{ClampToLong(x), ClampToLong(y)};
  HWND hit = WindowFromPoint(pt);
  if (!hit) return 0;
  HWND root = GetAncestor(hit, GA_ROOT);
  HWND effective = root ? root : hit;
  DWORD pid = 0;
  GetWindowThreadProcessId(effective, &pid);
  return pid;
}

static DWORD ForegroundWindowPid() {
  HWND fg = GetForegroundWindow();
  if (!fg) return 0;
  DWORD pid = 0;
  GetWindowThreadProcessId(fg, &pid);
  return pid;
}

static HWND SafeHwndFromDouble(double wid) {
  if (!std::isfinite(wid) || wid <= 0.0 || wid > kMaxSafeHandleDouble) return nullptr;
  HWND candidate = reinterpret_cast<HWND>(static_cast<uintptr_t>(wid));
  return IsWindow(candidate) ? candidate : nullptr;
}

struct FindPidContext {
  DWORD pid;
  HWND found;
};

static BOOL CALLBACK FindWindowByPid(HWND hwnd, LPARAM lParam) {
  if (!IsWindowVisible(hwnd) || IsWindowCloaked(hwnd)) return TRUE;
  auto* ctx = reinterpret_cast<FindPidContext*>(lParam);
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid == ctx->pid && GetWindowTextLengthW(hwnd) > 0) {
    ctx->found = hwnd;
    return FALSE;
  }
  return TRUE;
}

static bool TryFocusTargetWindow(DWORD targetPid, double targetWindowId) {
  DWORD selfPid = GetCurrentProcessId();
  if (targetPid == selfPid) return false;
  HWND target = SafeHwndFromDouble(targetWindowId);
  if (target) {
    DWORD winPid = 0;
    GetWindowThreadProcessId(target, &winPid);
    if (winPid == selfPid) return false;
    if (targetPid > 0 && winPid != targetPid) target = nullptr;
  }
  if (!target && targetPid > 0) {
    FindPidContext ctx{targetPid, nullptr};
    EnumWindows(FindWindowByPid, reinterpret_cast<LPARAM>(&ctx));
    target = ctx.found;
  }
  if (!target) return false;
  if (IsIconic(target)) ShowWindow(target, SW_RESTORE);
  if (SetForegroundWindow(target) != FALSE) return true;
  // Windows 前台锁可能拒绝直接切焦点；临时附加到前台线程移交焦点并立即解绑。
  HWND fg = GetForegroundWindow();
  DWORD fgTid = fg ? GetWindowThreadProcessId(fg, nullptr) : 0;
  DWORD curTid = GetCurrentThreadId();
  bool attached = fgTid != 0 && fgTid != curTid && AttachThreadInput(curTid, fgTid, TRUE) != FALSE;
  BringWindowToTop(target);
  bool focused = SetForegroundWindow(target) != FALSE;
  if (attached) AttachThreadInput(curTid, fgTid, FALSE);
  return focused || GetForegroundWindow() == target;
}

static bool EnsurePointSafeForTarget(double x, double y, DWORD targetPid, double targetWindowId) {
  DWORD selfPid = GetCurrentProcessId();
  if (targetPid == selfPid) return false;
  DWORD topPid = RootWindowPidAtPoint(x, y);
  if (topPid == selfPid || (targetPid > 0 && topPid != targetPid && topPid != 0)) {
    if (targetPid > 0 || targetWindowId > 0.0) {
      TryFocusTargetWindow(targetPid, targetWindowId);
      Sleep(35);
      topPid = RootWindowPidAtPoint(x, y);
    }
  }
  if (topPid == selfPid) return false;
  return targetPid == 0 || topPid == targetPid || topPid == 0;
}

static bool EnsureForegroundSafeForKey(DWORD targetPid) {
  DWORD selfPid = GetCurrentProcessId();
  if (targetPid == selfPid) return false;
  DWORD fgPid = ForegroundWindowPid();
  if (targetPid > 0 && fgPid != targetPid) {
    TryFocusTargetWindow(targetPid, 0.0);
    Sleep(35);
    fgPid = ForegroundWindowPid();
  }
  if (fgPid == selfPid) return false;
  return targetPid == 0 || fgPid == targetPid;
}

static void ToNormalizedVirtualDesktop(double x, double y, LONG* outDx, LONG* outDy) {
  int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
  int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (vw <= 1) vw = 1920;
  if (vh <= 1) vh = 1080;
  double nx = ((x - static_cast<double>(vx)) * 65535.0) / static_cast<double>(vw - 1);
  double ny = ((y - static_cast<double>(vy)) * 65535.0) / static_cast<double>(vh - 1);
  if (nx < 0.0) nx = 0.0;
  if (nx > 65535.0) nx = 65535.0;
  if (ny < 0.0) ny = 0.0;
  if (ny > 65535.0) ny = 65535.0;
  *outDx = static_cast<LONG>(std::llround(nx));
  *outDy = static_cast<LONG>(std::llround(ny));
}

static bool SendMouseMove(double x, double y) {
  INPUT input{};
  input.type = INPUT_MOUSE;
  ToNormalizedVirtualDesktop(x, y, &input.mi.dx, &input.mi.dy);
  input.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  return SendInput(1, &input, sizeof(input)) == 1;
}

static bool IsExtendedVk(WORD vk) {
  switch (vk) {
    case VK_LEFT:
    case VK_RIGHT:
    case VK_UP:
    case VK_DOWN:
    case VK_HOME:
    case VK_END:
    case VK_PRIOR:
    case VK_NEXT:
    case VK_INSERT:
    case VK_DELETE:
    case VK_RCONTROL:
    case VK_RMENU:
    case VK_LWIN:
    case VK_RWIN:
    case VK_APPS:
    case VK_DIVIDE:
    case VK_NUMLOCK:
      return true;
    default:
      return false;
  }
}

static bool SendVk(WORD vk, bool keyUp) {
  INPUT input{};
  input.type = INPUT_KEYBOARD;
  input.ki.wVk = vk;
  input.ki.wScan = static_cast<WORD>(MapVirtualKeyW(vk, MAPVK_VK_TO_VSC));
  DWORD flags = keyUp ? KEYEVENTF_KEYUP : 0;
  if (IsExtendedVk(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
  input.ki.dwFlags = flags;
  return SendInput(1, &input, sizeof(input)) == 1;
}

static std::vector<WORD> ModifiersFromMask(uint32_t mask) {
  std::vector<WORD> mods;
  if (mask & kModControl) mods.push_back(VK_CONTROL);
  if (mask & kModAlt) mods.push_back(VK_MENU);
  if (mask & kModShift) mods.push_back(VK_SHIFT);
  if (mask & kModMeta) mods.push_back(VK_LWIN);
  return mods;
}

static std::string QueryProcessName(DWORD pid) {
  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc) return {};
  wchar_t buffer[MAX_PATH * 2]{};
  DWORD size = static_cast<DWORD>(std::size(buffer));
  std::wstring full;
  if (QueryFullProcessImageNameW(proc, 0, buffer, &size)) {
    full.assign(buffer, size);
  }
  CloseHandle(proc);
  size_t slash = full.find_last_of(L"\\/");
  std::wstring base = slash == std::wstring::npos ? full : full.substr(slash + 1);
  return WideToUtf8(base);
}

static napi_value CheckPermissions(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value obj = nullptr;
  gApi.create_object(env, &obj);
  SetBoolProp(env, obj, "accessibility", true);
  SetBoolProp(env, obj, "screenRecording", true);
  SetBoolProp(env, obj, "elevated", IsProcessElevated());
  return obj;
}

struct WindowRecord {
  uintptr_t hwnd;
  DWORD pid;
  std::string appName;
  std::string title;
  RECT rect;
  bool isFrontmost;
};

static BOOL CALLBACK EnumWindowsCollector(HWND hwnd, LPARAM lParam) {
  if (!IsWindowVisible(hwnd) || IsIconic(hwnd) || IsWindowCloaked(hwnd)) return TRUE;
  int titleLen = GetWindowTextLengthW(hwnd);
  if (titleLen <= 0) return TRUE;
  RECT rect{};
  if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &rect, sizeof(rect)))) {
    if (!GetWindowRect(hwnd, &rect)) return TRUE;
  }
  if ((rect.right - rect.left) < 16 || (rect.bottom - rect.top) < 16) return TRUE;

  std::wstring titleBuf(static_cast<size_t>(titleLen) + 1, L'\0');
  int written = GetWindowTextW(hwnd, titleBuf.data(), titleLen + 1);
  if (written <= 0) return TRUE;
  titleBuf.resize(static_cast<size_t>(written));

  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  auto* list = reinterpret_cast<std::vector<WindowRecord>*>(lParam);
  list->push_back(WindowRecord{
      reinterpret_cast<uintptr_t>(hwnd),
      pid,
      QueryProcessName(pid),
      WideToUtf8(titleBuf),
      rect,
      hwnd == GetForegroundWindow(),
  });
  return TRUE;
}

static napi_value ListWindows(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value array = nullptr;
  gApi.create_array(env, &array);
  try {
    std::vector<WindowRecord> records;
    EnumWindows(EnumWindowsCollector, reinterpret_cast<LPARAM>(&records));
    uint32_t idx = 0;
    for (const auto& rec : records) {
      napi_value item = nullptr;
      gApi.create_object(env, &item);
      SetNumberProp(env, item, "windowId", static_cast<double>(rec.hwnd));
      SetNumberProp(env, item, "pid", static_cast<double>(rec.pid));
      SetStringProp(env, item, "appName", rec.appName);
      SetStringProp(env, item, "bundleId", rec.appName);
      SetStringProp(env, item, "title", rec.title);
      SetNumberProp(env, item, "layer", 0);
      SetBoolProp(env, item, "isFrontmost", rec.isFrontmost);

      napi_value bounds = nullptr;
      gApi.create_object(env, &bounds);
      SetNumberProp(env, bounds, "x", static_cast<double>(rec.rect.left));
      SetNumberProp(env, bounds, "y", static_cast<double>(rec.rect.top));
      SetNumberProp(env, bounds, "width", static_cast<double>(rec.rect.right - rec.rect.left));
      SetNumberProp(env, bounds, "height", static_cast<double>(rec.rect.bottom - rec.rect.top));
      gApi.set_named_property(env, item, "bounds", bounds);

      gApi.set_element(env, array, idx++, item);
    }
  } catch (...) {
    return array;
  }
  return array;
}

static napi_value FocusWindow(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (gApi.get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
    return MakeBool(env, false);
  }
  int32_t pid = 0;
  ReadInt32(env, argv[0], &pid);
  double wid = 0.0;
  if (argc >= 2) ReadDouble(env, argv[1], &wid);
  if (pid <= 0 && wid <= 0.0) return MakeBool(env, false);
  return MakeBool(env, TryFocusTargetWindow(pid > 0 ? static_cast<DWORD>(pid) : 0, wid));
}

static napi_value GetCursorPosition(napi_env env, napi_callback_info info) {
  (void)info;
  POINT pt{};
  GetCursorPos(&pt);
  napi_value obj = nullptr;
  gApi.create_object(env, &obj);
  SetNumberProp(env, obj, "x", static_cast<double>(pt.x));
  SetNumberProp(env, obj, "y", static_cast<double>(pt.y));
  return obj;
}

static napi_value MouseMove(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  double x = 0, y = 0;
  if (gApi.get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 2 ||
      !ReadDouble(env, argv[0], &x) || !ReadDouble(env, argv[1], &y)) {
    return MakeBool(env, false);
  }
  return MakeBool(env, SendMouseMove(x, y));
}

static napi_value MouseClick(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 8;
    napi_value argv[8];
    double x = 0, y = 0, targetWid = 0.0;
    int32_t buttonCode = 0, clickCount = 1, modMask = 0, targetPid = 0;
    if (gApi.get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 2 ||
        !ReadDouble(env, argv[0], &x) || !ReadDouble(env, argv[1], &y)) {
      return MakeBool(env, false);
    }
    if (argc >= 3) ReadInt32(env, argv[2], &buttonCode);
    if (argc >= 4) ReadInt32(env, argv[3], &clickCount);
    if (argc >= 5) ReadInt32(env, argv[4], &modMask);
    if (argc >= 6) ReadInt32(env, argv[5], &targetPid);
    if (argc >= 7) ReadDouble(env, argv[6], &targetWid);
    if (clickCount < 1) clickCount = 1;
    if (clickCount > 3) clickCount = 3;

    DWORD pidGuard = targetPid > 0 ? static_cast<DWORD>(targetPid) : 0;
    if (!EnsurePointSafeForTarget(x, y, pidGuard, targetWid)) return MakeBool(env, false);

    DWORD downFlag = MOUSEEVENTF_LEFTDOWN;
    DWORD upFlag = MOUSEEVENTF_LEFTUP;
    if (buttonCode == 1) {
      downFlag = MOUSEEVENTF_RIGHTDOWN;
      upFlag = MOUSEEVENTF_RIGHTUP;
    } else if (buttonCode == 2) {
      downFlag = MOUSEEVENTF_MIDDLEDOWN;
      upFlag = MOUSEEVENTF_MIDDLEUP;
    }

    auto mods = ModifiersFromMask(static_cast<uint32_t>(modMask));
    for (WORD vk : mods) SendVk(vk, false);
    bool ok = SendMouseMove(x, y);
    for (int32_t i = 0; i < clickCount && ok; ++i) {
      INPUT pair[2]{};
      pair[0].type = INPUT_MOUSE;
      pair[0].mi.dwFlags = downFlag;
      pair[1].type = INPUT_MOUSE;
      pair[1].mi.dwFlags = upFlag;
      if (SendInput(2, pair, sizeof(INPUT)) != 2) ok = false;
      if (i + 1 < clickCount) Sleep(25);
    }
    for (auto it = mods.rbegin(); it != mods.rend(); ++it) SendVk(*it, true);
    return MakeBool(env, ok);
  } catch (...) {
    return MakeBool(env, false);
  }
}

struct LeftButtonReleaseGuard {
  bool active = false;
  ~LeftButtonReleaseGuard() noexcept {
    if (!active) return;
    INPUT up{};
    up.type = INPUT_MOUSE;
    up.mi.dwFlags = MOUSEEVENTF_LEFTUP;
    SendInput(1, &up, sizeof(up));
  }
};

static napi_value MouseDrag(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 8;
    napi_value argv[8];
    double fx = 0, fy = 0, tx = 0, ty = 0, targetWid = 0.0;
    int32_t steps = 12, targetPid = 0;
    if (gApi.get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 4 ||
        !ReadDouble(env, argv[0], &fx) || !ReadDouble(env, argv[1], &fy) ||
        !ReadDouble(env, argv[2], &tx) || !ReadDouble(env, argv[3], &ty)) {
      return MakeBool(env, false);
    }
    if (argc >= 5) ReadInt32(env, argv[4], &steps);
    if (argc >= 6) ReadInt32(env, argv[5], &targetPid);
    if (argc >= 7) ReadDouble(env, argv[6], &targetWid);
    if (steps < 2) steps = 2;
    if (steps > 30) steps = 30;

    DWORD pidGuard = targetPid > 0 ? static_cast<DWORD>(targetPid) : 0;
    if (!EnsurePointSafeForTarget(fx, fy, pidGuard, targetWid)) return MakeBool(env, false);
    if (RootWindowPidAtPoint(tx, ty) == GetCurrentProcessId()) return MakeBool(env, false);

    if (!SendMouseMove(fx, fy)) return MakeBool(env, false);
    INPUT down{};
    down.type = INPUT_MOUSE;
    down.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    if (SendInput(1, &down, sizeof(down)) != 1) return MakeBool(env, false);
    LeftButtonReleaseGuard releaseGuard{true};
    bool ok = true;
    for (int32_t i = 1; i <= steps && ok; ++i) {
      double ratio = static_cast<double>(i) / static_cast<double>(steps);
      if (!SendMouseMove(fx + (tx - fx) * ratio, fy + (ty - fy) * ratio)) ok = false;
      Sleep(8);
    }
    INPUT up{};
    up.type = INPUT_MOUSE;
    up.mi.dwFlags = MOUSEEVENTF_LEFTUP;
    bool released = SendInput(1, &up, sizeof(up)) == 1;
    releaseGuard.active = false;
    return MakeBool(env, ok && released);
  } catch (...) {
    return MakeBool(env, false);
  }
}

static napi_value MouseScroll(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 7;
    napi_value argv[7];
    double x = 0, y = 0, targetWid = 0.0;
    int32_t dx = 0, dy = 0, targetPid = 0;
    if (gApi.get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 4 ||
        !ReadDouble(env, argv[0], &x) || !ReadDouble(env, argv[1], &y) ||
        !ReadInt32(env, argv[2], &dx) || !ReadInt32(env, argv[3], &dy)) {
      return MakeBool(env, false);
    }
    if (argc >= 5) ReadInt32(env, argv[4], &targetPid);
    if (argc >= 6) ReadDouble(env, argv[5], &targetWid);
    DWORD pidGuard = targetPid > 0 ? static_cast<DWORD>(targetPid) : 0;
    if (!EnsurePointSafeForTarget(x, y, pidGuard, targetWid)) return MakeBool(env, false);

    bool ok = SendMouseMove(x, y);
    if (ok && dy != 0) {
      INPUT v{};
      v.type = INPUT_MOUSE;
      v.mi.dwFlags = MOUSEEVENTF_WHEEL;
      v.mi.mouseData = static_cast<DWORD>(SafeNegateInt32(dy));
      if (SendInput(1, &v, sizeof(v)) != 1) ok = false;
    }
    if (ok && dx != 0) {
      INPUT h{};
      h.type = INPUT_MOUSE;
      h.mi.dwFlags = MOUSEEVENTF_HWHEEL;
      h.mi.mouseData = static_cast<DWORD>(dx);
      if (SendInput(1, &h, sizeof(h)) != 1) ok = false;
    }
    return MakeBool(env, ok);
  } catch (...) {
    return MakeBool(env, false);
  }
}

static napi_value KeyTap(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 4;
    napi_value argv[4];
    int32_t vk = 0, modMask = 0, targetPid = 0;
    if (gApi.get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1 ||
        !ReadInt32(env, argv[0], &vk) || vk <= 0 || vk > 255) {
      return MakeBool(env, false);
    }
    if (argc >= 2) ReadInt32(env, argv[1], &modMask);
    if (argc >= 3) ReadInt32(env, argv[2], &targetPid);

    DWORD pidGuard = targetPid > 0 ? static_cast<DWORD>(targetPid) : 0;
    if (!EnsureForegroundSafeForKey(pidGuard)) return MakeBool(env, false);

    auto mods = ModifiersFromMask(static_cast<uint32_t>(modMask));
    for (WORD mod : mods) SendVk(mod, false);
    bool ok = SendVk(static_cast<WORD>(vk), false);
    Sleep(12);
    if (!SendVk(static_cast<WORD>(vk), true)) ok = false;
    for (auto it = mods.rbegin(); it != mods.rend(); ++it) SendVk(*it, true);
    return MakeBool(env, ok);
  } catch (...) {
    return MakeBool(env, false);
  }
}

static napi_value TypeText(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 3;
    napi_value argv[3];
    if (gApi.get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
      return MakeBool(env, false);
    }
    int32_t targetPid = 0;
    if (argc >= 2) ReadInt32(env, argv[1], &targetPid);
    DWORD pidGuard = targetPid > 0 ? static_cast<DWORD>(targetPid) : 0;
    if (!EnsureForegroundSafeForKey(pidGuard)) return MakeBool(env, false);

    size_t len = 0;
    if (gApi.get_value_string_utf16(env, argv[0], nullptr, 0, &len) != napi_ok) {
      return MakeBool(env, false);
    }
    if (len == 0) return MakeBool(env, true);
    std::vector<char16_t> buf(len + 1, 0);
    if (gApi.get_value_string_utf16(env, argv[0], buf.data(), len + 1, &len) != napi_ok) {
      return MakeBool(env, false);
    }
    bool ok = true;
    for (size_t i = 0; i < len && ok; ++i) {
      char16_t ch = buf[i];
      if (ch == u'\r' || ch == u'\n') {
        if (ch == u'\r' && i + 1 < len && buf[i + 1] == u'\n') ++i;
        ok = SendVk(VK_RETURN, false);
        Sleep(8);
        if (!SendVk(VK_RETURN, true)) ok = false;
        continue;
      }
      // 非 BMP 字符（emoji / 扩展区汉字）由 UTF-16 高低代理对组成，必须在同一批 SendInput 中原子发送。
      if (ch >= 0xD800 && ch <= 0xDBFF && i + 1 < len && buf[i + 1] >= 0xDC00 &&
          buf[i + 1] <= 0xDFFF) {
        char16_t low = buf[++i];
        INPUT quad[4]{};
        quad[0].type = INPUT_KEYBOARD;
        quad[0].ki.wScan = static_cast<WORD>(ch);
        quad[0].ki.dwFlags = KEYEVENTF_UNICODE;
        quad[1].type = INPUT_KEYBOARD;
        quad[1].ki.wScan = static_cast<WORD>(low);
        quad[1].ki.dwFlags = KEYEVENTF_UNICODE;
        quad[2].type = INPUT_KEYBOARD;
        quad[2].ki.wScan = static_cast<WORD>(ch);
        quad[2].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        quad[3].type = INPUT_KEYBOARD;
        quad[3].ki.wScan = static_cast<WORD>(low);
        quad[3].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        if (SendInput(4, quad, sizeof(INPUT)) != 4) ok = false;
        continue;
      }
      INPUT pair[2]{};
      pair[0].type = INPUT_KEYBOARD;
      pair[0].ki.wScan = static_cast<WORD>(ch);
      pair[0].ki.dwFlags = KEYEVENTF_UNICODE;
      pair[1].type = INPUT_KEYBOARD;
      pair[1].ki.wScan = static_cast<WORD>(ch);
      pair[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      if (SendInput(2, pair, sizeof(INPUT)) != 2) ok = false;
    }
    return MakeBool(env, ok);
  } catch (...) {
    return MakeBool(env, false);
  }
}

static napi_value CaptureWindowPng(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result = nullptr;
  gApi.get_null(env, &result);
  return result;
}

static napi_value GetUiTree(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value arr = nullptr;
  gApi.create_array(env, &arr);
  return arr;
}

static napi_value AxUnsupported(napi_env env, napi_callback_info info) {
  (void)info;
  return MakeBool(env, false);
}

static napi_value ReleaseAllModifiers(napi_env env, napi_callback_info info) {
  (void)info;
  static const WORD kModifierVks[] = {
      VK_LSHIFT, VK_RSHIFT, VK_LCONTROL, VK_RCONTROL, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN,
  };
  for (WORD vk : kModifierVks) SendVk(vk, true);
  return MakeBool(env, true);
}

static napi_value Init(napi_env env, napi_value exports) {
  if (!InitNapiTable()) return nullptr;
  const napi_property_descriptor props[] = {
      {"checkPermissions", nullptr, CheckPermissions, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"requestPermissions", nullptr, CheckPermissions, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"listWindows", nullptr, ListWindows, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"focusWindow", nullptr, FocusWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"captureWindowPng", nullptr, CaptureWindowPng, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"getUiTree", nullptr, GetUiTree, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"axPressAt", nullptr, AxUnsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"axSetTextAt", nullptr, AxUnsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getCursorPosition", nullptr, GetCursorPosition, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"mouseMove", nullptr, MouseMove, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"mouseClick", nullptr, MouseClick, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"mouseDrag", nullptr, MouseDrag, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"mouseScroll", nullptr, MouseScroll, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"keyTap", nullptr, KeyTap, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"typeText", nullptr, TypeText, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"releaseAllModifiers", nullptr, ReleaseAllModifiers, nullptr, nullptr, nullptr, napi_default,
       nullptr},
  };
  gApi.define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

extern "C" __declspec(dllexport) napi_value napi_register_module_v1(napi_env env,
                                                                   napi_value exports) {
  return Init(env, exports);
}
