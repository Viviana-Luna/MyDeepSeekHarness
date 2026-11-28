// Windows 11 原生 DWM 硬件圆角同步与无厚边框窗口 8 向边缘/圆角缩放命中子类化。
// 不创建自定义 WinRT HostBackdropBrush 合成树，避免每帧桌面高斯模糊重采样与离屏裁剪开销。
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <windowsx.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <node_api.h>
#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>

#ifndef DWMWA_WINDOW_CORNER_PREFERENCE
#define DWMWA_WINDOW_CORNER_PREFERENCE 33
#endif

static constexpr int kDwmCornerDefault = 0;
static constexpr int kDwmCornerDoNotRound = 1;
static constexpr int kDwmCornerRound = 2;

// 稳定 Node-API 从当前宿主取址，避免将模块绑定到 node.exe 或特定 Electron 文件名。
template<class T> T nodeApi(const char* name) {
  auto address = GetProcAddress(GetModuleHandleW(nullptr), name);
  if (!address) throw std::runtime_error("Electron 缺少稳定原生接口");
  return reinterpret_cast<T>(address);
}
#define CALL(name, ...) nodeApi<decltype(&name)>(#name)(__VA_ARGS__)

struct State;
struct ResizeWindow {
  State* owner;
  HWND window;
  double radius;
  double logicalWidth;
  double scale;
  bool enabled;
  std::set<HWND> children;
  ResizeWindow(State* ownerValue, HWND windowValue, double radiusValue, double widthValue, double scaleValue, bool enabledValue)
      : owner(ownerValue), window(windowValue), radius(radiusValue), logicalWidth(widthValue), scale(scaleValue), enabled(enabledValue) {}
  ~ResizeWindow() noexcept;
};

struct State {
  std::set<HWND> activeWindows;
  std::map<HWND, std::unique_ptr<ResizeWindow>> resizeWindows;
  ~State() noexcept {
    resizeWindows.clear();
    activeWindows.clear();
  }
};

static constexpr UINT_PTR resizeSubclassId = 1;
static LRESULT CALLBACK resizeChildProcedure(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR) noexcept;

static bool attachResizeChild(HWND child, ResizeWindow& resize) noexcept {
  wchar_t name[64]{};
  DWORD process = 0;
  DWORD thread = GetWindowThreadProcessId(child, &process);
  if (process != GetCurrentProcessId() || thread != GetCurrentThreadId() || !IsChild(resize.window, child)
      || !GetClassNameW(child, name, 64) || wcscmp(name, L"Chrome_RenderWidgetHostHWND") != 0) return true;
  try {
    auto [entry, inserted] = resize.children.insert(child);
    if (inserted && !SetWindowSubclass(child, resizeChildProcedure, resizeSubclassId, reinterpret_cast<DWORD_PTR>(&resize))) {
      resize.children.erase(entry);
      return false;
    }
    return true;
  } catch (...) { return false; }
}

static bool attachResizeChildren(ResizeWindow& resize) noexcept {
  struct Inspection { ResizeWindow* resize; bool succeeded; } inspection{&resize, true};
  EnumChildWindows(resize.window, [](HWND child, LPARAM data) -> BOOL {
    auto inspection = reinterpret_cast<Inspection*>(data);
    inspection->succeeded = attachResizeChild(child, *inspection->resize);
    return inspection->succeeded ? TRUE : FALSE;
  }, reinterpret_cast<LPARAM>(&inspection));
  return inspection.succeeded;
}

static LRESULT resizeHit(HWND window, LPARAM position, const ResizeWindow& resize) noexcept {
  if (!resize.enabled || resize.radius == 0 || IsZoomed(window) || IsIconic(window)) return HTNOWHERE;
  RECT bounds{};
  if (!GetWindowRect(window, &bounds)) return HTNOWHERE;
  double width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
  double x = GET_X_LPARAM(position) - bounds.left + 0.5;
  double y = GET_Y_LPARAM(position) - bounds.top + 0.5;
  if (x < 0 || y < 0 || x >= width || y >= height) return HTNOWHERE;
  // 使用同步更新的缩放因子，避免拖拽缩放瞬间物理宽度与滞后 logicalWidth 错配导致热区畸变。
  double scale = resize.scale;
  // 8 DIP 小于画布留白；圆角内按到圆弧的距离命中，沿边留出 12 DIP 对角热区方便触控板抓取。
  double edge = 8.0 * scale;
  double radius = resize.radius * scale;
  double cornerSpan = std::max(radius, 12.0 * scale);
  bool inCornerArcX = x < radius || x >= width - radius;
  bool inCornerArcY = y < radius || y >= height - radius;
  if (inCornerArcX && inCornerArcY) {
    bool left = x < radius;
    bool top = y < radius;
    double dx = x - (left ? radius : width - radius);
    double dy = y - (top ? radius : height - radius);
    double distance = radius - std::hypot(dx, dy);
    if (distance >= -scale && distance <= edge) {
      return top ? (left ? HTTOPLEFT : HTTOPRIGHT) : (left ? HTBOTTOMLEFT : HTBOTTOMRIGHT);
    }
    return HTNOWHERE;
  }
  bool nearLeft = x < cornerSpan, nearRight = x >= width - cornerSpan;
  bool nearTop = y < cornerSpan, nearBottom = y >= height - cornerSpan;
  if ((nearLeft || nearRight) && (nearTop || nearBottom) && (x < edge || x >= width - edge || y < edge || y >= height - edge)) {
    return nearTop ? (nearLeft ? HTTOPLEFT : HTTOPRIGHT) : (nearLeft ? HTBOTTOMLEFT : HTBOTTOMRIGHT);
  }
  if (x < edge) return HTLEFT;
  if (x >= width - edge) return HTRIGHT;
  if (y < edge) return HTTOP;
  if (y >= height - edge) return HTBOTTOM;
  return HTNOWHERE;
}

static bool resizeCursor(const ResizeWindow& resize) noexcept {
  if (!resize.enabled || resize.radius == 0 || IsZoomed(resize.window)) return false;
  POINT point{};
  if (!GetCursorPos(&point)) return false;
  auto hit = resizeHit(resize.window, MAKELPARAM(point.x, point.y), resize);
  LPCWSTR cursor = nullptr;
  // 子窗口的光标消息可能仍标为 HTCLIENT；按真实位置选择系统光标。
  switch (hit) {
    case HTLEFT: case HTRIGHT: cursor = IDC_SIZEWE; break;
    case HTTOP: case HTBOTTOM: cursor = IDC_SIZENS; break;
    case HTTOPLEFT: case HTBOTTOMRIGHT: cursor = IDC_SIZENWSE; break;
    case HTTOPRIGHT: case HTBOTTOMLEFT: cursor = IDC_SIZENESW; break;
  }
  if (!cursor) return false;
  SetCursor(LoadCursorW(nullptr, cursor));
  return true;
}

static LRESULT hitThroughSubclass(HWND window, WPARAM wParam, LPARAM lParam, const ResizeWindow& resize) noexcept {
  auto hit = resizeHit(resize.window, lParam, resize);
  if (hit != HTNOWHERE) return hit;
  hit = DefSubclassProc(window, WM_NCHITTEST, wParam, lParam);
  if ((!resize.enabled || resize.radius == 0 || IsZoomed(resize.window) || IsIconic(resize.window))
      && hit >= HTLEFT && hit <= HTBOTTOMRIGHT) return HTCLIENT;
  return hit;
}

static LRESULT CALLBACK resizeChildProcedure(HWND child, UINT message, WPARAM wParam, LPARAM lParam,
    UINT_PTR id, DWORD_PTR data) noexcept {
  auto resize = reinterpret_cast<ResizeWindow*>(data);
  if (message == WM_NCDESTROY) {
    RemoveWindowSubclass(child, resizeChildProcedure, id);
    resize->children.erase(child);
    return DefSubclassProc(child, message, wParam, lParam);
  }
  // Chromium 子窗口绕过父 HWND 的命中检测；缩放区让 Windows 交给父窗口处理。
  if (message == WM_NCHITTEST) {
    if (resizeHit(resize->window, lParam, *resize) != HTNOWHERE) return HTTRANSPARENT;
    return hitThroughSubclass(child, wParam, lParam, *resize);
  }
  if (message == WM_SETCURSOR && resizeCursor(*resize)) return TRUE;
  // 内容层重新计算鼠标位置时会把系统缩放光标覆盖成箭头；缩放区的悬停由窗口层拥有。
  if ((message == WM_MOUSEMOVE || message == WM_NCMOUSEMOVE) && !GetCapture() && resizeCursor(*resize)) return 0;
  return DefSubclassProc(child, message, wParam, lParam);
}

static LRESULT CALLBACK resizeProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam,
    UINT_PTR id, DWORD_PTR data) noexcept {
  auto resize = reinterpret_cast<ResizeWindow*>(data);
  if (message == WM_NCDESTROY) {
    auto owner = resize->owner;
    RemoveWindowSubclass(window, resizeProcedure, id);
    owner->resizeWindows.erase(window);
    owner->activeWindows.erase(window);
    return DefSubclassProc(window, message, wParam, lParam);
  }
  if (message == WM_PARENTNOTIFY && LOWORD(wParam) == WM_CREATE) attachResizeChild(reinterpret_cast<HWND>(lParam), *resize);
  // Chromium 子窗口带 WS_EX_NOPARENTNOTIFY 且在最小化还原后会重建，需在窗口还原/显隐及空集合命中时补挂子类化。
  if ((message == WM_SIZE && wParam != SIZE_MINIMIZED) || (message == WM_SHOWWINDOW && wParam != FALSE)) {
    attachResizeChildren(*resize);
  }
  if (message == WM_NCHITTEST) {
    if (resize->children.empty()) attachResizeChildren(*resize);
    return hitThroughSubclass(window, wParam, lParam, *resize);
  }
  if (message == WM_SETCURSOR && resizeCursor(*resize)) return TRUE;
  if ((message == WM_MOUSEMOVE || message == WM_NCMOUSEMOVE) && !GetCapture() && resizeCursor(*resize)) return 0;
  return DefSubclassProc(window, message, wParam, lParam);
}

ResizeWindow::~ResizeWindow() noexcept {
  for (auto child : children) RemoveWindowSubclass(child, resizeChildProcedure, resizeSubclassId);
  RemoveWindowSubclass(window, resizeProcedure, resizeSubclassId);
}

static HWND parseHandle(napi_env env, napi_value value) {
  void* bytes = nullptr;
  size_t length = 0;
  if (CALL(napi_get_buffer_info, env, value, &bytes, &length) != napi_ok || length != sizeof(HWND)) {
    throw std::runtime_error("窗口句柄格式不正确");
  }
  return *static_cast<HWND*>(bytes);
}

static void requireOwnedWindow(HWND window) {
  DWORD process = 0;
  DWORD thread = GetWindowThreadProcessId(window, &process);
  if (!IsWindow(window) || process != GetCurrentProcessId() || thread != GetCurrentThreadId()) {
    throw std::runtime_error("窗口不属于当前主进程线程");
  }
}

static State* arguments(napi_env env, napi_callback_info info, size_t count, napi_value* values) {
  size_t length = count;
  void* data = nullptr;
  if (CALL(napi_get_cb_info, env, info, &length, values, nullptr, &data) != napi_ok || length != count || !data) {
    throw std::runtime_error("原生背景参数不正确");
  }
  return static_cast<State*>(data);
}

static napi_value undefined(napi_env env) {
  napi_value result;
  CALL(napi_get_undefined, env, &result);
  return result;
}

static napi_value fail(napi_env env, const std::string& message) {
  CALL(napi_throw_error, env, nullptr, message.c_str());
  return nullptr;
}

static void applyWindowCornerPreference(HWND window, int preference) {
  HRESULT hr = DwmSetWindowAttribute(
      window,
      DWMWA_WINDOW_CORNER_PREFERENCE,
      &preference,
      sizeof(preference));
  // 低于 Windows 11 Build 22000 的环境可能不支持属性 33，忽略 E_INVALIDARG 降级为系统默认矩形窗口。
  if (FAILED(hr) && hr != E_INVALIDARG) {
    throw std::runtime_error("设置原生 DWM 窗口圆角属性失败");
  }
}

static napi_value updateResize(napi_env env, napi_callback_info info) {
  try {
    napi_value values[4];
    auto state = arguments(env, info, 4, values);
    HWND window = parseHandle(env, values[0]);
    requireOwnedWindow(window);
    double radius = 0, logicalWidth = 0;
    bool enabled = false;
    if (CALL(napi_get_value_double, env, values[1], &radius) != napi_ok
        || CALL(napi_get_value_double, env, values[2], &logicalWidth) != napi_ok
        || CALL(napi_get_value_bool, env, values[3], &enabled) != napi_ok
        || !std::isfinite(radius) || radius < 0 || radius > 64
        || !std::isfinite(logicalWidth) || logicalWidth <= 0 || logicalWidth > 100000) {
      throw std::runtime_error("窗口缩放参数无效");
    }
    RECT client{};
    double scale = 1.0;
    if (GetClientRect(window, &client) && client.right > client.left) {
      scale = std::clamp(static_cast<double>(client.right - client.left) / logicalWidth, 0.5, 4.0);
    } else {
      scale = std::clamp(static_cast<double>(GetDpiForWindow(window)) / 96.0, 0.5, 4.0);
    }
    auto found = state->resizeWindows.find(window);
    if (found == state->resizeWindows.end()) {
      auto resize = std::make_unique<ResizeWindow>(state, window, radius, logicalWidth, scale, enabled);
      found = state->resizeWindows.emplace(window, std::move(resize)).first;
      if (!SetWindowSubclass(window, resizeProcedure, resizeSubclassId, reinterpret_cast<DWORD_PTR>(found->second.get()))) {
        state->resizeWindows.erase(found);
        throw std::runtime_error("无法安装窗口缩放命中检测");
      }
    }
    auto& resize = *found->second;
    resize.radius = radius;
    resize.logicalWidth = logicalWidth;
    resize.scale = scale;
    resize.enabled = enabled;
    applyWindowCornerPreference(window, radius > 0.0 ? kDwmCornerRound : kDwmCornerDoNotRound);
    if (!attachResizeChildren(resize)) throw std::runtime_error("无法同步 Chromium 窗口缩放命中检测");
    return undefined(env);
  } catch (const std::exception& error) { return fail(env, error.what()); }
}

static napi_value disposeResize(napi_env env, napi_callback_info info) {
  try {
    napi_value value;
    auto state = arguments(env, info, 1, &value);
    HWND window = parseHandle(env, value);
    if (state->resizeWindows.erase(window) > 0 && !state->activeWindows.contains(window) && IsWindow(window)) {
      int preference = kDwmCornerDefault;
      DwmSetWindowAttribute(
          window,
          DWMWA_WINDOW_CORNER_PREFERENCE,
          &preference,
          sizeof(preference));
    }
    return undefined(env);
  } catch (const std::exception& error) { return fail(env, error.what()); }
}

static napi_value resizeCount(napi_env env, napi_callback_info info) {
  try {
    auto state = arguments(env, info, 0, nullptr);
    napi_value result;
    CALL(napi_create_uint32, env, static_cast<uint32_t>(state->resizeWindows.size()), &result);
    return result;
  } catch (const std::exception& error) { return fail(env, error.what()); }
}

static napi_value resizeChildCount(napi_env env, napi_callback_info info) {
  try {
    auto state = arguments(env, info, 0, nullptr);
    uint32_t count = 0;
    for (auto& entry : state->resizeWindows) count += static_cast<uint32_t>(entry.second->children.size());
    napi_value result;
    CALL(napi_create_uint32, env, count, &result);
    return result;
  } catch (const std::exception& error) { return fail(env, error.what()); }
}

static napi_value update(napi_env env, napi_callback_info info) {
  try {
    napi_value values[3];
    auto state = arguments(env, info, 3, values);
    HWND window = parseHandle(env, values[0]);
    requireOwnedWindow(window);
    double radius = 0, logicalWidth = 0;
    if (CALL(napi_get_value_double, env, values[1], &radius) != napi_ok
        || CALL(napi_get_value_double, env, values[2], &logicalWidth) != napi_ok
        || !std::isfinite(radius) || radius < 0 || radius > 64
        || !std::isfinite(logicalWidth) || logicalWidth <= 0 || logicalWidth > 100000) {
      throw std::runtime_error("窗口圆角或尺寸无效");
    }
    applyWindowCornerPreference(window, radius > 0.0 ? kDwmCornerRound : kDwmCornerDoNotRound);
    state->activeWindows.insert(window);
    return undefined(env);
  } catch (const std::exception& error) {
    return fail(env, error.what());
  }
}

static napi_value dispose(napi_env env, napi_callback_info info) {
  try {
    napi_value value;
    auto state = arguments(env, info, 1, &value);
    HWND window = parseHandle(env, value);
    if (state->activeWindows.erase(window) > 0 && !state->resizeWindows.contains(window) && IsWindow(window)) {
      int preference = kDwmCornerDefault;
      DwmSetWindowAttribute(
          window,
          DWMWA_WINDOW_CORNER_PREFERENCE,
          &preference,
          sizeof(preference));
    }
    return undefined(env);
  } catch (const std::exception& error) { return fail(env, error.what()); }
}

static napi_value activeCount(napi_env env, napi_callback_info info) {
  try {
    auto state = arguments(env, info, 0, nullptr);
    napi_value result;
    CALL(napi_create_uint32, env, static_cast<uint32_t>(state->activeWindows.size()), &result);
    return result;
  } catch (const std::exception& error) { return fail(env, error.what()); }
}

NAPI_MODULE_INIT() {
  try {
    auto state = std::make_unique<State>();
    State* raw = state.get();
    if (CALL(napi_add_env_cleanup_hook, env, [](void* data) { delete static_cast<State*>(data); }, raw) != napi_ok) {
      throw std::runtime_error("无法注册原生背景清理钩子");
    }
    state.release();
    for (auto [name, callback] : {std::pair{"update", update}, {"dispose", dispose}, {"activeCount", activeCount},
         {"updateResize", updateResize}, {"disposeResize", disposeResize}, {"resizeCount", resizeCount},
         {"resizeChildCount", resizeChildCount}}) {
      napi_value function;
      CALL(napi_create_function, env, name, NAPI_AUTO_LENGTH, callback, raw, &function);
      CALL(napi_set_named_property, env, exports, name, function);
    }
    return exports;
  } catch (const std::exception& error) {
    return fail(env, error.what());
  } catch (...) {
    return fail(env, "原生背景模块初始化失败");
  }
}
