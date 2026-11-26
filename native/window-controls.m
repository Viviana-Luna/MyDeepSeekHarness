#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <math.h>
#include <node_api.h>
#include <string.h>

// 对齐 macOS 标准红绿灯间距（经典系统 12pt+8pt=20pt，macOS 27 14pt+8pt=22pt）。
static const CGFloat kTrafficLightGap = 8.0;

static NSWindow *WindowFromValue(napi_env env, napi_value handle) {
  void *data = NULL;
  size_t length = 0;
  if (![NSThread isMainThread]
      || napi_get_buffer_info(env, handle, &data, &length) != napi_ok
      || length != sizeof(void *)) {
    napi_throw_type_error(env, NULL, "原生窗口控件需要主线程提供有效的窗口句柄。");
    return nil;
  }
  void *view = NULL;
  memcpy(&view, data, sizeof(view));
  // 仅匹配本进程现存窗口，不解引用调用方提供的指针。
  for (NSWindow *window in NSApp.windows) {
    if (view && (__bridge void *)window.contentView == view) return window;
  }
  napi_throw_error(env, NULL, "原生窗口句柄已失效。");
  return nil;
}

static NSWindow *WindowFromHandle(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value handle;
  if (napi_get_cb_info(env, info, &argc, &handle, NULL, NULL) != napi_ok || argc != 1) {
    napi_throw_type_error(env, NULL, "原生窗口控件需要主线程提供有效的窗口句柄。");
    return nil;
  }
  return WindowFromValue(env, handle);
}

static BOOL ButtonBelongsToWindow(NSButton *button, NSWindow *window) {
  return button != nil && button.superview != nil && button.superview.window == window;
}

static NSArray<NSButton *> *WindowButtons(NSWindow *window) {
  NSButton *close = [window standardWindowButton:NSWindowCloseButton];
  NSButton *minimize = [window standardWindowButton:NSWindowMiniaturizeButton];
  NSButton *zoom = [window standardWindowButton:NSWindowZoomButton];
  if (!ButtonBelongsToWindow(close, window)
      || !ButtonBelongsToWindow(minimize, window)
      || !ButtonBelongsToWindow(zoom, window)) {
    return @[];
  }
  return @[close, minimize, zoom];
}

static BOOL ReadCurrentTopLeft(NSWindow *window, NSPoint *outPoint) {
  NSButton *first = WindowButtons(window).firstObject;
  if (!first) return NO;
  NSRect frame = [first.superview convertRect:first.frame toView:nil];
  *outPoint = NSMakePoint(NSMinX(frame), NSHeight(window.frame) - NSMaxY(frame));
  return YES;
}

@interface DSHCompactWindowButtons : NSObject {
  __weak NSWindow *_window;
  BOOL _adjusting;
  NSPoint _topLeft;
}
- (instancetype)initWithWindow:(NSWindow *)window anchor:(NSPoint)topLeft;
- (void)setAnchor:(NSPoint)topLeft;
- (void)layout:(NSNotification *)notification;
@end

@implementation DSHCompactWindowButtons
- (instancetype)initWithWindow:(NSWindow *)window anchor:(NSPoint)topLeft {
  if ((self = [super init])) {
    _window = window;
    // 使用窗口坐标固定锚点；系统 sheet 会重建或移动按钮所在的标题栏容器。
    _topLeft = topLeft;
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    for (NSButton *button in WindowButtons(window)) {
      button.postsFrameChangedNotifications = YES;
      [center addObserver:self selector:@selector(layout:)
                     name:NSViewFrameDidChangeNotification object:button];
    }
    // AppKit 可在显示、换肤或全屏切换时重建按钮布局。
    [center addObserver:self selector:@selector(layout:)
                   name:NSWindowDidUpdateNotification object:window];
    [self layout:nil];
  }
  return self;
}
- (void)setAnchor:(NSPoint)topLeft {
  _topLeft = topLeft;
  [self layout:nil];
}
- (void)layout:(NSNotification *)notification {
  (void)notification;
  NSWindow *window = _window;
  if (!window || _adjusting || (window.styleMask & NSWindowStyleMaskFullScreen)) return;
  NSArray<NSButton *> *buttons = WindowButtons(window);
  if (buttons.count != 3) return;
  _adjusting = YES;
  @try {
    CGFloat x = _topLeft.x;
    for (NSButton *button in buttons) {
      if (!ButtonBelongsToWindow(button, window)) break;
      NSRect target = NSMakeRect(x, NSHeight(window.frame) - _topLeft.y - NSHeight(button.frame),
                                NSWidth(button.frame), NSHeight(button.frame));
      NSPoint origin = [button.superview convertRect:target fromView:nil].origin;
      if (!NSEqualPoints(button.frame.origin, origin)) {
        [button setFrameOrigin:origin];
      }
      x += NSWidth(button.frame) + kTrafficLightGap;
    }
  } @finally {
    _adjusting = NO;
  }
}
- (void)dealloc {
  [NSNotificationCenter.defaultCenter removeObserver:self];
}
@end

static napi_value Compact(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok
      || (argc != 1 && argc != 3)) {
    napi_throw_type_error(env, NULL, "红绿灯布局需要提供窗口句柄或窗口句柄与坐标。");
    return NULL;
  }
  NSWindow *window = WindowFromValue(env, argv[0]);
  if (!window) return NULL;
  NSPoint anchor = NSZeroPoint;
  BOOL hasAnchor = NO;
  if (argc == 3) {
    double x = 0;
    double y = 0;
    if (napi_get_value_double(env, argv[1], &x) != napi_ok
        || napi_get_value_double(env, argv[2], &y) != napi_ok
        || !isfinite(x) || !isfinite(y)
        || x < 0 || y < 0
        || x > NSWidth(window.frame) || y > NSHeight(window.frame)) {
      napi_throw_type_error(env, NULL, "红绿灯锚点坐标必须位于窗口有效范围内。");
      return NULL;
    }
    anchor = NSMakePoint((CGFloat)x, (CGFloat)y);
    hasAnchor = YES;
  } else {
    hasAnchor = ReadCurrentTopLeft(window, &anchor);
  }
  static char observerKey;
  DSHCompactWindowButtons *observer = objc_getAssociatedObject(window, &observerKey);
  if (!observer) {
    if (hasAnchor && WindowButtons(window).count == 3) {
      observer = [[DSHCompactWindowButtons alloc] initWithWindow:window anchor:anchor];
      objc_setAssociatedObject(window, &observerKey, observer, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
  } else if (argc == 3) {
    [observer setAnchor:anchor];
  } else {
    [observer layout:nil];
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value ReadLayout(napi_env env, napi_callback_info info) {
  NSWindow *window = WindowFromHandle(env, info);
  if (!window) return NULL;
  napi_value result;
  napi_create_array(env, &result);
  uint32_t index = 0;
  for (NSButton *button in WindowButtons(window)) {
    NSRect frame = [button.superview convertRect:button.frame toView:nil];
    const char *keys[] = {"x", "y", "width", "height"};
    double values[] = {NSMinX(frame), NSHeight(window.frame) - NSMaxY(frame),
                       NSWidth(frame), NSHeight(frame)};
    napi_value item;
    napi_create_object(env, &item);
    for (size_t i = 0; i < 4; i++) {
      napi_value value;
      napi_create_double(env, values[i], &value);
      napi_set_named_property(env, item, keys[i], value);
    }
    napi_set_element(env, result, index++, item);
  }
  return result;
}

static napi_value CancelDirectorySheet(napi_env env, napi_callback_info info) {
  NSWindow *window = WindowFromHandle(env, info);
  if (!window) return NULL;
  NSWindow *sheet = window.attachedSheet;
  // 系统能力请求只拥有目录选择，不得连带取消图片附件或保存对话框。
  if ([sheet isKindOfClass:NSOpenPanel.class]) {
    NSOpenPanel *panel = (NSOpenPanel *)sheet;
    if (panel.canChooseDirectories && !panel.canChooseFiles) [panel cancel:nil];
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value CancelFileSheet(napi_env env, napi_callback_info info) {
  NSWindow *window = WindowFromHandle(env, info);
  if (!window) return NULL;
  NSWindow *sheet = window.attachedSheet;
  // 仅取消连接模块当前发起的纯文件选择 sheet，不影响目录选择或保存对话框。
  if ([sheet isKindOfClass:NSOpenPanel.class]) {
    NSOpenPanel *panel = (NSOpenPanel *)sheet;
    if (panel.canChooseFiles && !panel.canChooseDirectories) [panel cancel:nil];
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"compact", NULL, Compact, NULL, NULL, NULL, napi_default, NULL},
    {"readLayout", NULL, ReadLayout, NULL, NULL, NULL, napi_default, NULL},
    {"cancelDirectorySheet", NULL, CancelDirectorySheet, NULL, NULL, NULL, napi_default, NULL},
    {"cancelFileSheet", NULL, CancelFileSheet, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, 4, methods);
  return exports;
}

NAPI_MODULE(window_controls, Init)
