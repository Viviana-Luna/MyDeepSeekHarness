// MyDSH macOS 系统级 Computer Use 原生模块（ScreenCaptureKit + Accessibility + CoreGraphics + AppKit）。
// 所有耗时截帧、AX 遍历与 HID 时序均运行在 Node-API 异步工作线程，Electron 主线程零阻塞；
// 投递真实 HID 事件前强制执行 getpid() 硬防自锁核对，彻底杜绝误点/误键击中 MyDSH 自身导致退出。
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include <math.h>
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static const uint32_t kModAlt = 1u << 0;
static const uint32_t kModControl = 1u << 1;
static const uint32_t kModMeta = 1u << 2;
static const uint32_t kModShift = 1u << 3;

static CGEventFlags FlagsFromMask(uint32_t mask) {
  CGEventFlags flags = 0;
  if (mask & kModAlt) flags |= kCGEventFlagMaskAlternate;
  if (mask & kModControl) flags |= kCGEventFlagMaskControl;
  if (mask & kModMeta) flags |= kCGEventFlagMaskCommand;
  if (mask & kModShift) flags |= kCGEventFlagMaskShift;
  return flags;
}

static bool ReadDoubleArg(napi_env env, napi_value val, double *out) {
  return napi_get_value_double(env, val, out) == napi_ok && isfinite(*out);
}

static bool ReadInt32Arg(napi_env env, napi_value val, int32_t *out) {
  return napi_get_value_int32(env, val, out) == napi_ok;
}

static bool ReadBoolArg(napi_env env, napi_value val, bool *out) {
  return napi_get_value_bool(env, val, out) == napi_ok;
}

static napi_value MakeBool(napi_env env, bool value) {
  napi_value result = NULL;
  napi_get_boolean(env, value, &result);
  return result;
}

static napi_value MakeNull(napi_env env) {
  napi_value result = NULL;
  napi_get_null(env, &result);
  return result;
}

static napi_value MakeUtf8(napi_env env, NSString *str) {
  napi_value result = NULL;
  const char *utf8 = str ? str.UTF8String : "";
  napi_create_string_utf8(env, utf8 ? utf8 : "", NAPI_AUTO_LENGTH, &result);
  return result;
}

static void SetNumberProp(napi_env env, napi_value obj, const char *key, double value) {
  napi_value num = NULL;
  napi_create_double(env, value, &num);
  napi_set_named_property(env, obj, key, num);
}

static void SetBoolProp(napi_env env, napi_value obj, const char *key, bool value) {
  napi_set_named_property(env, obj, key, MakeBool(env, value));
}

static void SetStringProp(napi_env env, napi_value obj, const char *key, NSString *value) {
  napi_set_named_property(env, obj, key, MakeUtf8(env, value));
}

static napi_value MakeRectObj(napi_env env, CGRect rect) {
  napi_value obj = NULL;
  napi_create_object(env, &obj);
  SetNumberProp(env, obj, "x", rect.origin.x);
  SetNumberProp(env, obj, "y", rect.origin.y);
  SetNumberProp(env, obj, "width", rect.size.width);
  SetNumberProp(env, obj, "height", rect.size.height);
  return obj;
}

static CGEventSourceRef CreateFastEventSource(void) {
  CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
  if (src) CGEventSourceSetLocalEventsSuppressionInterval(src, 0.0);
  return src;
}

static CGPoint ReadCurrentCursor(void) {
  CGEventRef ev = CGEventCreate(NULL);
  CGPoint loc = ev ? CGEventGetLocation(ev) : CGPointZero;
  if (ev) CFRelease(ev);
  return loc;
}

static void RestoreCursorPosition(CGPoint pt) {
  CGWarpMouseCursorPosition(pt);
  CGAssociateMouseAndMouseCursorPosition(true);
}

static bool IsTrackedWindowLayer(int layer) {
  // 包含普通窗口(0)、浮动/模态安全授权面板(3..19, 如 SecurityAgent/CoreServicesUIAgent)以及弹出交互层(101, 如急停胶囊)；
  // 排除负层桌面、Dock(20)/菜单栏(24)/状态栏(25)与 screen-saver 层(1000, 点击穿透虚拟光标)。
  if (layer == 0 || layer == 101) return true;
  return layer >= 3 && layer <= 19;
}

static int32_t SafeNegateInt32(int32_t value) {
  if (value == INT32_MIN) return INT32_MAX;
  return -value;
}

static NSString *TruncateNsString(NSString *str, NSUInteger maxLen) {
  if (!str || str.length <= maxLen) return str ?: @"";
  NSRange range = [str rangeOfComposedCharacterSequenceAtIndex:maxLen];
  NSUInteger cut = range.location <= maxLen ? range.location : maxLen;
  return [str substringToIndex:cut];
}

// 优先通过线程安全的 Accessibility 系统级 Mach IPC 读取实时前台 PID，避免 AppKit 主线程缓存竞态与主线程阻塞死锁。
static pid_t CurrentFrontmostPid(void) {
  if (AXIsProcessTrusted()) {
    AXUIElementRef sysWide = AXUIElementCreateSystemWide();
    if (sysWide) {
      AXUIElementSetMessagingTimeout(sysWide, 0.05f);
      CFTypeRef focusedApp = NULL;
      pid_t axPid = 0;
      if (AXUIElementCopyAttributeValue(sysWide, kAXFocusedApplicationAttribute, &focusedApp) ==
              kAXErrorSuccess &&
          focusedApp) {
        if (CFGetTypeID(focusedApp) == AXUIElementGetTypeID()) {
          AXUIElementGetPid((AXUIElementRef)focusedApp, &axPid);
        }
        CFRelease(focusedApp);
      }
      CFRelease(sysWide);
      if (axPid > 0) return axPid;
    }
  }
  @autoreleasepool {
    @try {
      return NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    } @catch (NSException *ex) {
      (void)ex;
      return 0;
    }
  }
}

// 纯 CoreGraphics Z 序命中：包含普通窗口与可交互安全弹窗/浮窗层，排除透明及点击穿透虚拟光标层。
static pid_t TopWindowPidAtPoint(double x, double y) {
  @autoreleasepool {
    @try {
      CFArrayRef raw = CGWindowListCopyWindowInfo(
          kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
      if (!raw) return 0;
      NSArray *windows = (__bridge_transfer NSArray *)raw;
      for (NSDictionary *entry in windows) {
        NSNumber *layerNum = entry[(__bridge NSString *)kCGWindowLayer];
        int layer = layerNum ? layerNum.intValue : 0;
        if (!IsTrackedWindowLayer(layer)) continue;
        NSNumber *alphaNum = entry[(__bridge NSString *)kCGWindowAlpha];
        if (alphaNum && alphaNum.doubleValue <= 0.01) continue;
        NSDictionary *boundsDict = entry[(__bridge NSString *)kCGWindowBounds];
        CGRect rect = CGRectZero;
        if (!boundsDict || !CGRectMakeWithDictionaryRepresentation(
                               (__bridge CFDictionaryRef)boundsDict, &rect)) {
          continue;
        }
        if (rect.size.width < 16.0 || rect.size.height < 16.0) continue;
        if (x >= rect.origin.x && x <= rect.origin.x + rect.size.width && y >= rect.origin.y &&
            y <= rect.origin.y + rect.size.height) {
          NSNumber *pidNum = entry[(__bridge NSString *)kCGWindowOwnerPID];
          return pidNum ? (pid_t)pidNum.intValue : 0;
        }
      }
    } @catch (NSException *ex) {
      (void)ex;
    }
  }
  return 0;
}

static void ActivateAppOnMainThread(pid_t pid) {
  @autoreleasepool {
    @try {
      NSRunningApplication *app =
          [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
      if (!app) return;
      if (@available(macOS 14.0, *)) {
        if (pid == getpid()) {
          [NSApp activate];
        } else {
          // macOS 14+ 协作激活：主动向目标应用让渡焦点，避免系统静默忽略后台切前台请求。
          [NSApp yieldActivationToApplication:app];
          [app activateWithOptions:NSApplicationActivateAllWindows];
        }
      } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        [app activateWithOptions:(NSApplicationActivateAllWindows |
                                  NSApplicationActivateIgnoringOtherApps)];
#pragma clang diagnostic pop
      }
    } @catch (NSException *ex) {
      (void)ex;
    }
  }
}

// 通过 Accessibility 权限直接将目标应用设为前台，补齐 macOS 14+ 协作激活在非前台宿主下的跨应用边界。
static void PromotePidViaAccessibility(pid_t pid) {
  if (pid <= 0 || !AXIsProcessTrusted()) return;
  AXUIElementRef appElem = AXUIElementCreateApplication(pid);
  if (!appElem) return;
  AXUIElementSetMessagingTimeout(appElem, 0.06f);
  AXUIElementSetAttributeValue(appElem, kAXFrontmostAttribute, kCFBooleanTrue);
  CFRelease(appElem);
}

// 非阻塞派发激活请求，避免工作线程 dispatch_sync 在应用退出阶段与主线程互锁。
static void RequestActivatePidAsync(pid_t pid) {
  if (pid <= 0) return;
  if ([NSThread isMainThread]) {
    ActivateAppOnMainThread(pid);
    if (pid != getpid()) PromotePidViaAccessibility(pid);
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    ActivateAppOnMainThread(pid);
  });
  PromotePidViaAccessibility(pid);
}

static bool WaitUntilFrontmost(pid_t targetPid, int maxWaitMs) {
  if (targetPid <= 0) return false;
  int waited = 0;
  while (waited < maxWaitMs) {
    if (CurrentFrontmostPid() == targetPid) return true;
    usleep(12000);
    waited += 12;
  }
  return CurrentFrontmostPid() == targetPid;
}

static bool WaitUntilPointSafeForTarget(double x, double y, pid_t targetPid, int maxWaitMs) {
  pid_t selfPid = getpid();
  int waited = 0;
  while (waited < maxWaitMs) {
    pid_t topPid = TopWindowPidAtPoint(x, y);
    if (topPid != selfPid && (targetPid <= 0 || topPid == targetPid || topPid == 0)) return true;
    usleep(12000);
    waited += 12;
  }
  pid_t finalTop = TopWindowPidAtPoint(x, y);
  return finalTop != selfPid && (targetPid <= 0 || finalTop == targetPid || finalTop == 0);
}

static void PostHidEvent(CGEventRef event) {
  if (!event) return;
  CGEventSetTimestamp(event, clock_gettime_nsec_np(CLOCK_UPTIME_RAW));
  CGEventPost(kCGHIDEventTap, event);
}

// ---------- Accessibility 辅助 ----------

static NSString *CopyAxStringAttr(AXUIElementRef elem, CFStringRef attr) {
  CFTypeRef val = NULL;
  if (AXUIElementCopyAttributeValue(elem, attr, &val) != kAXErrorSuccess || !val) return nil;
  NSString *out = nil;
  if (CFGetTypeID(val) == CFStringGetTypeID()) out = [(__bridge NSString *)val copy];
  CFRelease(val);
  return out;
}

static bool ReadAxRect(AXUIElementRef elem, CGRect *outRect) {
  CFTypeRef posVal = NULL;
  CFTypeRef sizeVal = NULL;
  if (AXUIElementCopyAttributeValue(elem, kAXPositionAttribute, &posVal) != kAXErrorSuccess ||
      !posVal) {
    return false;
  }
  if (AXUIElementCopyAttributeValue(elem, kAXSizeAttribute, &sizeVal) != kAXErrorSuccess ||
      !sizeVal) {
    CFRelease(posVal);
    return false;
  }
  CGPoint pt = CGPointZero;
  CGSize sz = CGSizeZero;
  bool ok = (CFGetTypeID(posVal) == AXValueGetTypeID()) &&
            (CFGetTypeID(sizeVal) == AXValueGetTypeID()) &&
            AXValueGetValue((AXValueRef)posVal, kAXValueTypeCGPoint, &pt) &&
            AXValueGetValue((AXValueRef)sizeVal, kAXValueTypeCGSize, &sz);
  CFRelease(posVal);
  CFRelease(sizeVal);
  if (!ok || sz.width < 2.0 || sz.height < 2.0) return false;
  *outRect = CGRectMake(pt.x, pt.y, sz.width, sz.height);
  return true;
}

static bool AxElementHasAction(AXUIElementRef elem, CFStringRef wanted) {
  CFArrayRef actions = NULL;
  if (AXUIElementCopyActionNames(elem, &actions) != kAXErrorSuccess || !actions) return false;
  bool found = false;
  CFIndex count = CFArrayGetCount(actions);
  for (CFIndex i = 0; i < count; i++) {
    CFStringRef name = (CFStringRef)CFArrayGetValueAtIndex(actions, i);
    if (name && CFEqual(name, wanted)) {
      found = true;
      break;
    }
  }
  CFRelease(actions);
  return found;
}

static bool AxRoleIsSecure(NSString *role, NSString *subrole) {
  return [role isEqualToString:@"AXSecureTextField"] ||
         [subrole isEqualToString:@"AXSecureTextField"];
}

static bool AxRoleIsEditable(NSString *role, NSString *subrole) {
  if (AxRoleIsSecure(role, subrole)) return false;
  return [role isEqualToString:@"AXTextField"] || [role isEqualToString:@"AXTextArea"] ||
         [role isEqualToString:@"AXComboBox"] || [role isEqualToString:@"AXSearchField"] ||
         [subrole isEqualToString:@"AXSearchField"];
}

static bool AxRoleIsDirectlyPressable(NSString *role) {
  return [role isEqualToString:@"AXButton"] || [role isEqualToString:@"AXLink"] ||
         [role isEqualToString:@"AXCheckBox"] || [role isEqualToString:@"AXRadioButton"] ||
         [role isEqualToString:@"AXPopUpButton"] || [role isEqualToString:@"AXMenuButton"] ||
         [role isEqualToString:@"AXMenuItem"] || [role isEqualToString:@"AXTabButton"] ||
         [role isEqualToString:@"AXSwitch"] || [role isEqualToString:@"AXDisclosureTriangle"] ||
         [role isEqualToString:@"AXIncrementor"];
}

static void WarmUpAxForApp(AXUIElementRef appElem) {
  AXUIElementSetAttributeValue(appElem, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
  AXUIElementSetAttributeValue(appElem, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
}

static AXUIElementRef CopyMatchingAxWindow(AXUIElementRef appElem, CGRect targetBounds,
                                           bool hasBounds) {
  CFTypeRef winListRef = NULL;
  if (AXUIElementCopyAttributeValue(appElem, kAXWindowsAttribute, &winListRef) != kAXErrorSuccess ||
      !winListRef) {
    return NULL;
  }
  if (CFGetTypeID(winListRef) != CFArrayGetTypeID()) {
    CFRelease(winListRef);
    return NULL;
  }
  CFArrayRef winList = (CFArrayRef)winListRef;
  CFIndex count = CFArrayGetCount(winList);
  AXUIElementRef best = NULL;
  double bestScore = 1e18;
  for (CFIndex i = 0; i < count; i++) {
    CFTypeRef item = CFArrayGetValueAtIndex(winList, i);
    if (!item || CFGetTypeID(item) != AXUIElementGetTypeID()) continue;
    AXUIElementRef candidate = (AXUIElementRef)item;
    if (!hasBounds) {
      best = (AXUIElementRef)CFRetain(candidate);
      break;
    }
    CGRect r = CGRectZero;
    if (!ReadAxRect(candidate, &r)) continue;
    double score = fabs(r.origin.x - targetBounds.origin.x) +
                   fabs(r.origin.y - targetBounds.origin.y) +
                   fabs(r.size.width - targetBounds.size.width) +
                   fabs(r.size.height - targetBounds.size.height);
    if (score < bestScore) {
      bestScore = score;
      if (best) CFRelease(best);
      best = (AXUIElementRef)CFRetain(candidate);
    }
  }
  CFRelease(winListRef);
  return best;
}

static bool LookupCgWindowBounds(int32_t windowId, CGRect *outRect) {
  if (windowId <= 0) return false;
  CFArrayRef list =
      CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, (CGWindowID)windowId);
  if (!list) return false;
  bool found = false;
  @autoreleasepool {
    @try {
      NSArray *arr = (__bridge_transfer NSArray *)list;
      if (arr.count > 0) {
        NSDictionary *dict = arr[0][(__bridge NSString *)kCGWindowBounds];
        if (dict && CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)dict, outRect)) {
          found = true;
        }
      }
    } @catch (NSException *ex) {
      (void)ex;
    }
  }
  return found;
}

static void RaiseTargetAxWindow(int32_t pid, int32_t windowId) {
  if (pid <= 0 || pid == getpid()) return;
  CGRect cgBounds = CGRectZero;
  bool hasBounds = LookupCgWindowBounds(windowId, &cgBounds);
  AXUIElementRef appElem = AXUIElementCreateApplication((pid_t)pid);
  if (!appElem) return;
  AXUIElementSetMessagingTimeout(appElem, 0.06f);
  AXUIElementRef win = CopyMatchingAxWindow(appElem, cgBounds, hasBounds);
  if (win) {
    AXUIElementPerformAction(win, kAXRaiseAction);
    CFRelease(win);
  }
  CFRelease(appElem);
}

// ---------- ScreenCaptureKit 异步去阴影独立窗口截帧 ----------

typedef struct {
  int32_t windowId;
  int32_t maxLongEdge;
  uint8_t *pngBytes;
  size_t pngLen;
  CGRect frame;
  bool ok;
  napi_deferred deferred;
  napi_async_work work;
} CaptureWork;

static void RunCaptureWindowBlocking(CaptureWork *job) {
  job->ok = false;
  job->pngBytes = NULL;
  job->pngLen = 0;
  if (job->windowId <= 0 || !CGPreflightScreenCaptureAccess()) return;
  if (@available(macOS 14.0, *)) {
    @autoreleasepool {
      @try {
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        __block NSData *pngData = nil;
        __block CGRect capturedFrame = CGRectZero;
        int32_t wid = job->windowId;
        double maxEdgeLimit = job->maxLongEdge >= 320 ? (double)job->maxLongEdge : 1280.0;

        [SCShareableContent
            getShareableContentExcludingDesktopWindows:YES
                                   onScreenWindowsOnly:NO
                                     completionHandler:^(SCShareableContent *content, NSError *err) {
                                       @try {
                                         if (err || !content) {
                                           dispatch_semaphore_signal(sem);
                                           return;
                                         }
                                         SCWindow *target = nil;
                                         for (SCWindow *w in content.windows) {
                                           if ((int32_t)w.windowID == wid) {
                                             target = w;
                                             break;
                                           }
                                         }
                                         if (!target || target.frame.size.width < 8.0 ||
                                             target.frame.size.height < 8.0) {
                                           dispatch_semaphore_signal(sem);
                                           return;
                                         }
                                         capturedFrame = target.frame;
                                         SCContentFilter *filter = [[SCContentFilter alloc]
                                             initWithDesktopIndependentWindow:target];
                                         SCStreamConfiguration *cfg =
                                             [[SCStreamConfiguration alloc] init];
                                         double scale = 1.5;
                                         double maxEdge = fmax(target.frame.size.width * scale,
                                                               target.frame.size.height * scale);
                                         if (maxEdge > maxEdgeLimit) scale *= maxEdgeLimit / maxEdge;
                                         cfg.width = (size_t)fmax(
                                             16.0, llround(target.frame.size.width * scale));
                                         cfg.height = (size_t)fmax(
                                             16.0, llround(target.frame.size.height * scale));
                                         cfg.scalesToFit = YES;
                                         cfg.showsCursor = NO;
                                         cfg.ignoreShadowsSingleWindow = YES;
                                         cfg.captureResolution = SCCaptureResolutionBest;

                                         [SCScreenshotManager
                                             captureImageWithFilter:filter
                                                      configuration:cfg
                                                  completionHandler:^(CGImageRef image,
                                                                      NSError *capErr) {
                                                    @try {
                                                      if (!capErr && image) {
                                                        NSMutableData *buf = [NSMutableData data];
                                                        CGImageDestinationRef dest =
                                                            CGImageDestinationCreateWithData(
                                                                (__bridge CFMutableDataRef)buf,
                                                                (__bridge CFStringRef)
                                                                    UTTypePNG.identifier,
                                                                1, NULL);
                                                        if (dest) {
                                                          CGImageDestinationAddImage(dest, image,
                                                                                     NULL);
                                                          if (CGImageDestinationFinalize(dest)) {
                                                            pngData = [buf copy];
                                                          }
                                                          CFRelease(dest);
                                                        }
                                                      }
                                                    } @catch (NSException *innerEx) {
                                                      (void)innerEx;
                                                    }
                                                    dispatch_semaphore_signal(sem);
                                                  }];
                                       } @catch (NSException *outerEx) {
                                         (void)outerEx;
                                         dispatch_semaphore_signal(sem);
                                       }
                                     }];

        dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC));
        if (dispatch_semaphore_wait(sem, timeout) == 0 && pngData && pngData.length > 0) {
          job->pngBytes = (uint8_t *)malloc(pngData.length);
          if (job->pngBytes) {
            memcpy(job->pngBytes, pngData.bytes, pngData.length);
            job->pngLen = pngData.length;
            job->frame = capturedFrame;
            job->ok = true;
          }
        }
      } @catch (NSException *ex) {
        (void)ex;
      }
    }
  }
}

static void ExecuteCaptureWork(napi_env env, void *data) {
  (void)env;
  RunCaptureWindowBlocking((CaptureWork *)data);
}

static void CompleteCaptureWork(napi_env env, napi_status status, void *data) {
  CaptureWork *job = (CaptureWork *)data;
  if (status != napi_cancelled) {
    napi_value result = MakeNull(env);
    if (status == napi_ok && job->ok && job->pngBytes && job->pngLen > 0) {
      void *copied = NULL;
      napi_value nodeBuf = NULL;
      if (napi_create_buffer_copy(env, job->pngLen, job->pngBytes, &copied, &nodeBuf) == napi_ok &&
          nodeBuf) {
        napi_create_object(env, &result);
        napi_set_named_property(env, result, "png", nodeBuf);
        napi_set_named_property(env, result, "bounds", MakeRectObj(env, job->frame));
      }
    }
    napi_resolve_deferred(env, job->deferred, result);
  }
  napi_delete_async_work(env, job->work);
  free(job->pngBytes);
  free(job);
}

static napi_value CaptureWindowPngAsync(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  int32_t windowId = 0, maxLongEdge = 1280;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc >= 1) ReadInt32Arg(env, argv[0], &windowId);
  if (argc >= 2) ReadInt32Arg(env, argv[1], &maxLongEdge);

  CaptureWork *job = (CaptureWork *)calloc(1, sizeof(CaptureWork));
  if (!job) return MakeNull(env);
  job->windowId = windowId;
  job->maxLongEdge = maxLongEdge;
  napi_value promise = NULL;
  napi_value name = NULL;
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "mydsh.captureWindowPng", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, NULL, name, ExecuteCaptureWork, CompleteCaptureWork, job,
                             &job->work) != napi_ok) {
    if (job->work) napi_delete_async_work(env, job->work);
    free(job);
    return MakeNull(env);
  }
  if (napi_queue_async_work(env, job->work) != napi_ok) {
    napi_resolve_deferred(env, job->deferred, MakeNull(env));
    napi_delete_async_work(env, job->work);
    free(job);
    return promise;
  }
  return promise;
}

static napi_value CaptureWindowPng(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  int32_t windowId = 0, maxLongEdge = 1280;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 ||
      !ReadInt32Arg(env, argv[0], &windowId) || windowId <= 0) {
    return MakeNull(env);
  }
  if (argc >= 2) ReadInt32Arg(env, argv[1], &maxLongEdge);
  CaptureWork job = {.windowId = windowId, .maxLongEdge = maxLongEdge};
  RunCaptureWindowBlocking(&job);
  if (!job.ok || !job.pngBytes || job.pngLen == 0) {
    free(job.pngBytes);
    return MakeNull(env);
  }
  void *copied = NULL;
  napi_value nodeBuf = NULL;
  if (napi_create_buffer_copy(env, job.pngLen, job.pngBytes, &copied, &nodeBuf) != napi_ok ||
      !nodeBuf) {
    free(job.pngBytes);
    return MakeNull(env);
  }
  napi_value outObj = NULL;
  napi_create_object(env, &outObj);
  napi_set_named_property(env, outObj, "png", nodeBuf);
  napi_set_named_property(env, outObj, "bounds", MakeRectObj(env, job.frame));
  free(job.pngBytes);
  return outObj;
}

// ---------- 有界异步 AX 语义树采集（120ms 硬预算 + 240 节点上限 + 类型与异常防护） ----------

typedef struct {
  char *role;
  char *title;
  char *value;
  bool editable;
  bool pressable;
  CGRect bounds;
} CollectedUiNode;

typedef struct {
  int32_t pid;
  int32_t windowId;
  int32_t maxNodes;
  CollectedUiNode *items;
  size_t count;
  napi_deferred deferred;
  napi_async_work work;
} UiTreeWork;

static char *DupNsString(NSString *str) {
  const char *utf8 = str ? str.UTF8String : "";
  return strdup(utf8 ? utf8 : "");
}

static void FreeUiTreeItems(CollectedUiNode *items, size_t count) {
  if (!items) return;
  for (size_t i = 0; i < count; i++) {
    free(items[i].role);
    free(items[i].title);
    free(items[i].value);
  }
  free(items);
}

static void CollectUiTreeWorker(UiTreeWork *job) {
  job->items = NULL;
  job->count = 0;
  if (job->pid <= 0 || job->pid == getpid() || !AXIsProcessTrusted()) return;
  int32_t maxNodes = job->maxNodes < 10 ? 10 : (job->maxNodes > 100 ? 100 : job->maxNodes);
  job->items = (CollectedUiNode *)calloc((size_t)maxNodes, sizeof(CollectedUiNode));
  if (!job->items) return;

  @autoreleasepool {
    @try {
      AXUIElementRef appElem = AXUIElementCreateApplication((pid_t)job->pid);
      if (!appElem) return;
      AXUIElementSetMessagingTimeout(appElem, 0.06f);
      WarmUpAxForApp(appElem);

      CGRect targetBounds = CGRectZero;
      bool hasBounds = LookupCgWindowBounds(job->windowId, &targetBounds);
      AXUIElementRef rootWin = CopyMatchingAxWindow(appElem, targetBounds, hasBounds);
      CFRelease(appElem);
      if (!rootWin) return;

      CGRect winRect = CGRectZero;
      bool hasWinRect = ReadAxRect(rootWin, &winRect);
      if (!hasWinRect && hasBounds) {
        winRect = targetBounds;
        hasWinRect = true;
      }

      NSMutableArray *queue = [NSMutableArray arrayWithObject:(__bridge id)rootWin];
      NSMutableArray<NSNumber *> *depths = [NSMutableArray arrayWithObject:@0];
      CFRelease(rootWin);

      uint64_t deadlineNs = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) + 120ULL * 1000000ULL;
      size_t head = 0;
      size_t visited = 0;
      const size_t kMaxVisited = 240;

      while (head < queue.count && (int32_t)job->count < maxNodes && visited < kMaxVisited) {
        if ((visited & 7u) == 0 && clock_gettime_nsec_np(CLOCK_UPTIME_RAW) >= deadlineNs) break;
        CFTypeRef rawElem = (__bridge CFTypeRef)queue[head];
        int depth = depths[head].intValue;
        head += 1;
        visited += 1;
        if (!rawElem || CFGetTypeID(rawElem) != AXUIElementGetTypeID()) continue;
        AXUIElementRef elem = (AXUIElementRef)rawElem;

        NSString *role = CopyAxStringAttr(elem, kAXRoleAttribute) ?: @"";
        NSString *subrole = CopyAxStringAttr(elem, kAXSubroleAttribute) ?: @"";
        bool secure = AxRoleIsSecure(role, subrole);
        bool editable = AxRoleIsEditable(role, subrole);
        bool directPress = !secure && AxRoleIsDirectlyPressable(role);
        bool pressable = directPress || (!secure && AxElementHasAction(elem, kAXPressAction));

        CGRect rect = CGRectZero;
        bool hasRect = ReadAxRect(elem, &rect);
        bool inWindow = !hasWinRect || (hasRect && CGRectIntersectsRect(winRect, rect));

        if (hasRect && inWindow && (editable || pressable)) {
          NSString *title = CopyAxStringAttr(elem, kAXTitleAttribute);
          if (title.length == 0) title = CopyAxStringAttr(elem, kAXDescriptionAttribute);
          if (title.length == 0) title = CopyAxStringAttr(elem, kAXHelpAttribute);
          NSString *valStr = secure ? @"" : (CopyAxStringAttr(elem, kAXValueAttribute) ?: @"");
          if (title.length == 0 && valStr.length > 0 && !editable) title = valStr;
          title = [title
              stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]
                      ?: @"";
          title = TruncateNsString(title, 80);
          valStr = TruncateNsString(valStr, 60);

          if ((editable || directPress || title.length > 0) && rect.size.width < 1200.0 &&
              rect.size.height < 600.0) {
            CollectedUiNode *slot = &job->items[job->count++];
            slot->role = DupNsString(role);
            slot->title = DupNsString(title);
            slot->value = DupNsString(editable ? valStr : @"");
            slot->editable = editable;
            slot->pressable = pressable;
            slot->bounds = rect;
          }
        }

        if (depth >= 8) continue;
        CFTypeRef childrenRef = NULL;
        if (AXUIElementCopyAttributeValue(elem, kAXChildrenAttribute, &childrenRef) ==
                kAXErrorSuccess &&
            childrenRef) {
          if (CFGetTypeID(childrenRef) == CFArrayGetTypeID()) {
            NSArray *children = (__bridge NSArray *)childrenRef;
            NSUInteger limit = children.count > 40 ? 40 : children.count;
            for (NSUInteger i = 0; i < limit; i++) {
              id child = children[i];
              if (child && CFGetTypeID((__bridge CFTypeRef)child) == AXUIElementGetTypeID()) {
                [queue addObject:child];
                [depths addObject:@(depth + 1)];
              }
            }
          }
          CFRelease(childrenRef);
        }
      }
    } @catch (NSException *ex) {
      (void)ex;
    }
  }
}

static napi_value BuildUiTreeJsArray(napi_env env, const CollectedUiNode *items, size_t count) {
  napi_value arr = NULL;
  napi_create_array_with_length(env, count, &arr);
  for (size_t i = 0; i < count; i++) {
    napi_value node = NULL;
    napi_create_object(env, &node);
    napi_value role = NULL, title = NULL, val = NULL;
    napi_create_string_utf8(env, items[i].role ?: "", NAPI_AUTO_LENGTH, &role);
    napi_create_string_utf8(env, items[i].title ?: "", NAPI_AUTO_LENGTH, &title);
    napi_create_string_utf8(env, items[i].value ?: "", NAPI_AUTO_LENGTH, &val);
    napi_set_named_property(env, node, "role", role);
    napi_set_named_property(env, node, "title", title);
    napi_set_named_property(env, node, "value", val);
    SetBoolProp(env, node, "editable", items[i].editable);
    SetBoolProp(env, node, "pressable", items[i].pressable);
    napi_set_named_property(env, node, "bounds", MakeRectObj(env, items[i].bounds));
    napi_set_element(env, arr, (uint32_t)i, node);
  }
  return arr;
}

static void ExecuteUiTreeWork(napi_env env, void *data) {
  (void)env;
  CollectUiTreeWorker((UiTreeWork *)data);
}

static void CompleteUiTreeWork(napi_env env, napi_status status, void *data) {
  UiTreeWork *job = (UiTreeWork *)data;
  if (status != napi_cancelled) {
    napi_value arr = status == napi_ok ? BuildUiTreeJsArray(env, job->items, job->count)
                                       : BuildUiTreeJsArray(env, NULL, 0);
    napi_resolve_deferred(env, job->deferred, arr);
  }
  napi_delete_async_work(env, job->work);
  FreeUiTreeItems(job->items, job->count);
  free(job);
}

static napi_value GetUiTreeAsync(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int32_t pid = 0, windowId = 0, maxNodes = 60;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc >= 1) ReadInt32Arg(env, argv[0], &pid);
  if (argc >= 2) ReadInt32Arg(env, argv[1], &windowId);
  if (argc >= 3) ReadInt32Arg(env, argv[2], &maxNodes);

  UiTreeWork *job = (UiTreeWork *)calloc(1, sizeof(UiTreeWork));
  if (!job) return BuildUiTreeJsArray(env, NULL, 0);
  job->pid = pid;
  job->windowId = windowId;
  job->maxNodes = maxNodes;
  napi_value promise = NULL;
  napi_value name = NULL;
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "mydsh.getUiTree", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, NULL, name, ExecuteUiTreeWork, CompleteUiTreeWork, job,
                             &job->work) != napi_ok) {
    if (job->work) napi_delete_async_work(env, job->work);
    free(job);
    return BuildUiTreeJsArray(env, NULL, 0);
  }
  if (napi_queue_async_work(env, job->work) != napi_ok) {
    napi_resolve_deferred(env, job->deferred, BuildUiTreeJsArray(env, NULL, 0));
    napi_delete_async_work(env, job->work);
    free(job);
    return promise;
  }
  return promise;
}

static napi_value GetUiTree(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int32_t pid = 0, windowId = 0, maxNodes = 60;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc >= 1) ReadInt32Arg(env, argv[0], &pid);
  if (argc >= 2) ReadInt32Arg(env, argv[1], &windowId);
  if (argc >= 3) ReadInt32Arg(env, argv[2], &maxNodes);
  UiTreeWork job = {.pid = pid, .windowId = windowId, .maxNodes = maxNodes};
  CollectUiTreeWorker(&job);
  napi_value arr = BuildUiTreeJsArray(env, job.items, job.count);
  FreeUiTreeItems(job.items, job.count);
  return arr;
}

// ---------- 纯后台 AX 直达与后台线程 HID 投递（内置 getpid() 硬防自锁门禁） ----------

static bool RunAxPressBlocking(int32_t pid, double x, double y) {
  if (pid <= 0 || pid == getpid() || !AXIsProcessTrusted()) return false;
  @autoreleasepool {
    @try {
      AXUIElementRef appElem = AXUIElementCreateApplication((pid_t)pid);
      if (!appElem) return false;
      AXUIElementSetMessagingTimeout(appElem, 0.08f);
      WarmUpAxForApp(appElem);
      AXUIElementRef current = NULL;
      AXError err = AXUIElementCopyElementAtPosition(appElem, (float)x, (float)y, &current);
      CFRelease(appElem);
      if (err != kAXErrorSuccess || !current) return false;

      bool pressed = false;
      for (int depth = 0; depth < 3 && current != NULL; depth++) {
        NSString *role = CopyAxStringAttr(current, kAXRoleAttribute) ?: @"";
        NSString *subrole = CopyAxStringAttr(current, kAXSubroleAttribute) ?: @"";
        if (AxRoleIsSecure(role, subrole) || AxRoleIsEditable(role, subrole)) {
          CFRelease(current);
          return false;
        }
        if (AxRoleIsDirectlyPressable(role) && AxElementHasAction(current, kAXPressAction)) {
          pressed = (AXUIElementPerformAction(current, kAXPressAction) == kAXErrorSuccess);
          CFRelease(current);
          return pressed;
        }
        CFTypeRef parent = NULL;
        AXError pErr = AXUIElementCopyAttributeValue(current, kAXParentAttribute, &parent);
        CFRelease(current);
        current = (pErr == kAXErrorSuccess && parent &&
                   CFGetTypeID(parent) == AXUIElementGetTypeID())
                      ? (AXUIElementRef)parent
                      : NULL;
        if (parent && !current) CFRelease(parent);
      }
      if (current) CFRelease(current);
      return pressed;
    } @catch (NSException *ex) {
      (void)ex;
      return false;
    }
  }
}

static bool RunAxSetTextBlocking(int32_t pid, double x, double y, const char *utf8Text,
                                 size_t utf8Len) {
  if (pid <= 0 || pid == getpid() || !utf8Text || !AXIsProcessTrusted()) return false;
  @autoreleasepool {
    @try {
      NSString *text = [[NSString alloc] initWithBytes:utf8Text
                                                length:utf8Len
                                              encoding:NSUTF8StringEncoding];
      if (!text) return false;
      AXUIElementRef appElem = AXUIElementCreateApplication((pid_t)pid);
      if (!appElem) return false;
      AXUIElementSetMessagingTimeout(appElem, 0.08f);
      WarmUpAxForApp(appElem);

      AXUIElementRef elem = NULL;
      // 使用 isfinite 判定是否存在显式坐标，兼容副屏负坐标 (x < 0 或 y < 0)。
      if (isfinite(x) && isfinite(y)) {
        AXUIElementCopyElementAtPosition(appElem, (float)x, (float)y, &elem);
      }
      if (!elem) {
        CFTypeRef focused = NULL;
        if (AXUIElementCopyAttributeValue(appElem, kAXFocusedUIElementAttribute, &focused) ==
                kAXErrorSuccess &&
            focused) {
          if (CFGetTypeID(focused) == AXUIElementGetTypeID()) elem = (AXUIElementRef)focused;
          else CFRelease(focused);
        }
      }
      CFRelease(appElem);
      if (!elem) return false;

      NSString *role = CopyAxStringAttr(elem, kAXRoleAttribute) ?: @"";
      NSString *subrole = CopyAxStringAttr(elem, kAXSubroleAttribute) ?: @"";
      if (!AxRoleIsEditable(role, subrole)) {
        CFRelease(elem);
        return false;
      }
      Boolean settable = false;
      if (AXUIElementIsAttributeSettable(elem, kAXValueAttribute, &settable) != kAXErrorSuccess ||
          !settable) {
        CFRelease(elem);
        return false;
      }
      AXUIElementSetAttributeValue(elem, kAXFocusedAttribute, kCFBooleanTrue);
      bool verified = false;
      if (AXUIElementSetAttributeValue(elem, kAXValueAttribute, (__bridge CFTypeRef)text) ==
          kAXErrorSuccess) {
        NSString *after = CopyAxStringAttr(elem, kAXValueAttribute);
        verified = (after != nil && [after isEqualToString:text]);
      }
      CFRelease(elem);
      return verified;
    } @catch (NSException *ex) {
      (void)ex;
      return false;
    }
  }
}

typedef enum {
  kOpAxPress,
  kOpAxSetText,
  kOpMouseClick,
  kOpMouseDrag,
  kOpMouseScroll,
  kOpKeyTap,
} InputOpKind;

typedef struct {
  InputOpKind kind;
  double x, y, tx, ty;
  int32_t a, b, c;
  int32_t targetPid;
  int32_t targetWindowId;
  bool flag;
  char *text;
  size_t textLen;
  bool result;
  napi_deferred deferred;
  napi_async_work work;
} InputWork;

static bool RunMouseClickBlocking(const InputWork *job) {
  pid_t selfPid = getpid();
  if (job->targetPid == selfPid) return false;
  int32_t buttonCode = job->a;
  int32_t clickCount = job->b < 1 ? 1 : (job->b > 3 ? 3 : job->b);
  int32_t modMask = job->c;
  CGEventType downType = kCGEventLeftMouseDown;
  CGEventType upType = kCGEventLeftMouseUp;
  CGMouseButton btn = kCGMouseButtonLeft;
  if (buttonCode == 1) {
    downType = kCGEventRightMouseDown;
    upType = kCGEventRightMouseUp;
    btn = kCGMouseButtonRight;
  } else if (buttonCode == 2) {
    downType = kCGEventOtherMouseDown;
    upType = kCGEventOtherMouseUp;
    btn = kCGMouseButtonCenter;
  }

  CGPoint savedCursor = ReadCurrentCursor();
  pid_t prevFrontPid = CurrentFrontmostPid();
  bool switchedApp = false;
  if (job->targetPid > 0 && (pid_t)job->targetPid != prevFrontPid) {
    RequestActivatePidAsync((pid_t)job->targetPid);
    if (job->targetWindowId > 0) RaiseTargetAxWindow(job->targetPid, job->targetWindowId);
    switchedApp = WaitUntilFrontmost((pid_t)job->targetPid, 180);
  }
  // 投递前二次核验：若坐标点仍被 MyDSH 自身窗口遮挡，立即硬拒，绝不把点击落到自身窗口！
  if (!WaitUntilPointSafeForTarget(job->x, job->y, (pid_t)job->targetPid, 96)) {
    if (job->flag && switchedApp && prevFrontPid > 0) RequestActivatePidAsync(prevFrontPid);
    return false;
  }

  CGEventSourceRef src = CreateFastEventSource();
  CGPoint pt = CGPointMake(job->x, job->y);
  CGEventFlags flags = FlagsFromMask((uint32_t)modMask);
  CGEventRef move = CGEventCreateMouseEvent(src, kCGEventMouseMoved, pt, btn);
  if (move) {
    PostHidEvent(move);
    CFRelease(move);
    usleep(12000);
  }
  bool ok = true;
  for (int32_t i = 1; i <= clickCount; i++) {
    CGEventRef down = CGEventCreateMouseEvent(src, downType, pt, btn);
    CGEventRef up = CGEventCreateMouseEvent(src, upType, pt, btn);
    if (!down || !up) {
      if (down) CFRelease(down);
      if (up) CFRelease(up);
      ok = false;
      break;
    }
    CGEventSetIntegerValueField(down, kCGMouseEventClickState, i);
    CGEventSetIntegerValueField(up, kCGMouseEventClickState, i);
    // 始终显式写入修饰键掩码（包括 0），防止物理按住的修饰键泄漏到普通点击中。
    CGEventSetFlags(down, flags);
    CGEventSetFlags(up, flags);
    PostHidEvent(down);
    usleep(28000);
    PostHidEvent(up);
    CFRelease(down);
    CFRelease(up);
    if (i < clickCount) usleep(26000);
  }
  if (src) CFRelease(src);

  if (job->flag) {
    usleep(28000);
    RestoreCursorPosition(savedCursor);
    if (switchedApp && prevFrontPid > 0) RequestActivatePidAsync(prevFrontPid);
  }
  return ok;
}

static bool RunMouseDragBlocking(const InputWork *job) {
  pid_t selfPid = getpid();
  if (job->targetPid == selfPid) return false;
  int32_t steps = job->a < 2 ? 2 : (job->a > 30 ? 30 : job->a);
  CGPoint savedCursor = ReadCurrentCursor();
  pid_t prevFrontPid = CurrentFrontmostPid();
  bool switchedApp = false;
  if (job->targetPid > 0 && (pid_t)job->targetPid != prevFrontPid) {
    RequestActivatePidAsync((pid_t)job->targetPid);
    if (job->targetWindowId > 0) RaiseTargetAxWindow(job->targetPid, job->targetWindowId);
    switchedApp = WaitUntilFrontmost((pid_t)job->targetPid, 120);
  }
  if (!WaitUntilPointSafeForTarget(job->x, job->y, (pid_t)job->targetPid, 80)) {
    if (job->flag && switchedApp && prevFrontPid > 0) RequestActivatePidAsync(prevFrontPid);
    return false;
  }

  CGEventSourceRef src = CreateFastEventSource();
  CGPoint start = CGPointMake(job->x, job->y);
  CGPoint end = CGPointMake(job->tx, job->ty);
  CGEventRef move = CGEventCreateMouseEvent(src, kCGEventMouseMoved, start, kCGMouseButtonLeft);
  if (move) {
    PostHidEvent(move);
    CFRelease(move);
    usleep(12000);
  }
  CGEventRef down = CGEventCreateMouseEvent(src, kCGEventLeftMouseDown, start, kCGMouseButtonLeft);
  if (!down) {
    if (src) CFRelease(src);
    if (job->flag && switchedApp && prevFrontPid > 0) RequestActivatePidAsync(prevFrontPid);
    return false;
  }
  CGEventSetFlags(down, 0);
  PostHidEvent(down);
  CFRelease(down);
  usleep(16000);
  for (int32_t i = 1; i <= steps; i++) {
    double r = (double)i / (double)steps;
    CGPoint cur = CGPointMake(job->x + (job->tx - job->x) * r, job->y + (job->ty - job->y) * r);
    CGEventRef drag = CGEventCreateMouseEvent(src, kCGEventLeftMouseDragged, cur, kCGMouseButtonLeft);
    if (drag) {
      CGEventSetFlags(drag, 0);
      PostHidEvent(drag);
      CFRelease(drag);
    }
    usleep(8000);
  }
  CGEventRef up = CGEventCreateMouseEvent(src, kCGEventLeftMouseUp, end, kCGMouseButtonLeft);
  bool upOk = (up != NULL);
  if (up) {
    CGEventSetFlags(up, 0);
    PostHidEvent(up);
    CFRelease(up);
  }
  if (src) CFRelease(src);
  if (job->flag) {
    usleep(28000);
    RestoreCursorPosition(savedCursor);
    if (switchedApp && prevFrontPid > 0) RequestActivatePidAsync(prevFrontPid);
  }
  return upOk;
}

static bool RunMouseScrollBlocking(const InputWork *job) {
  pid_t selfPid = getpid();
  if (job->targetPid == selfPid) return false;
  CGPoint savedCursor = ReadCurrentCursor();
  pid_t prevFrontPid = CurrentFrontmostPid();
  bool switchedApp = false;
  if (job->flag && job->targetPid > 0 && (pid_t)job->targetPid != prevFrontPid) {
    RequestActivatePidAsync((pid_t)job->targetPid);
    if (job->targetWindowId > 0) RaiseTargetAxWindow(job->targetPid, job->targetWindowId);
    switchedApp = WaitUntilFrontmost((pid_t)job->targetPid, 180);
  }
  if (!WaitUntilPointSafeForTarget(job->x, job->y, (pid_t)job->targetPid, 60)) {
    if (switchedApp && prevFrontPid > 0) RequestActivatePidAsync(prevFrontPid);
    return false;
  }
  CGEventSourceRef src = CreateFastEventSource();
  CGPoint pt = CGPointMake(job->x, job->y);
  CGEventRef move = CGEventCreateMouseEvent(src, kCGEventMouseMoved, pt, kCGMouseButtonLeft);
  if (move) {
    PostHidEvent(move);
    CFRelease(move);
    usleep(10000);
  }
  CGEventRef scroll = CGEventCreateScrollWheelEvent(
      src, kCGScrollEventUnitPixel, 2, SafeNegateInt32(job->b), SafeNegateInt32(job->a));
  if (scroll) {
    CGEventSetLocation(scroll, pt);
    PostHidEvent(scroll);
    CFRelease(scroll);
  }
  if (src) CFRelease(src);
  if (job->targetPid > 0 || job->flag) {
    usleep(18000);
    RestoreCursorPosition(savedCursor);
  }
  if (switchedApp && prevFrontPid > 0) RequestActivatePidAsync(prevFrontPid);
  return scroll != NULL;
}

static bool RunKeyTapBlocking(const InputWork *job) {
  pid_t selfPid = getpid();
  if (job->targetPid == selfPid) return false;
  pid_t prevFrontPid = CurrentFrontmostPid();
  bool switchedApp = false;
  if (job->targetPid > 0 && (pid_t)job->targetPid != prevFrontPid) {
    RequestActivatePidAsync((pid_t)job->targetPid);
    switchedApp = WaitUntilFrontmost((pid_t)job->targetPid, 180);
  }
  // 投递键盘前硬核验：前台仍为 MyDSH 自身进程或未切至预期目标时绝不发出任何真实按键（防止误触 Command+Q/W 闪退）。
  pid_t activePid = CurrentFrontmostPid();
  if (activePid == selfPid || (job->targetPid > 0 && activePid != (pid_t)job->targetPid)) {
    if (job->flag && switchedApp && prevFrontPid > 0) RequestActivatePidAsync(prevFrontPid);
    return false;
  }

  CGEventSourceRef src = CreateFastEventSource();
  CGEventFlags flags = FlagsFromMask((uint32_t)job->b);
  CGEventRef down = CGEventCreateKeyboardEvent(src, (CGKeyCode)job->a, true);
  CGEventRef up = CGEventCreateKeyboardEvent(src, (CGKeyCode)job->a, false);
  bool ok = (down != NULL && up != NULL);
  if (ok) {
    CGEventSetFlags(down, flags);
    CGEventSetFlags(up, flags);
    PostHidEvent(down);
    usleep(22000);
    PostHidEvent(up);
  }
  if (down) CFRelease(down);
  if (up) CFRelease(up);
  if (src) CFRelease(src);
  if (job->flag && switchedApp && prevFrontPid > 0) {
    usleep(28000);
    RequestActivatePidAsync(prevFrontPid);
  }
  return ok;
}

static void ExecuteInputWork(napi_env env, void *data) {
  (void)env;
  InputWork *job = (InputWork *)data;
  switch (job->kind) {
    case kOpAxPress:
      job->result = RunAxPressBlocking(job->targetPid, job->x, job->y);
      break;
    case kOpAxSetText:
      job->result = RunAxSetTextBlocking(job->targetPid, job->x, job->y, job->text, job->textLen);
      break;
    case kOpMouseClick:
      job->result = RunMouseClickBlocking(job);
      break;
    case kOpMouseDrag:
      job->result = RunMouseDragBlocking(job);
      break;
    case kOpMouseScroll:
      job->result = RunMouseScrollBlocking(job);
      break;
    case kOpKeyTap:
      job->result = RunKeyTapBlocking(job);
      break;
  }
}

static void CompleteInputWork(napi_env env, napi_status status, void *data) {
  InputWork *job = (InputWork *)data;
  if (status != napi_cancelled) {
    napi_resolve_deferred(env, job->deferred, MakeBool(env, status == napi_ok && job->result));
  }
  napi_delete_async_work(env, job->work);
  free(job->text);
  free(job);
}

static napi_value QueueInputWork(napi_env env, InputWork *job, const char *label) {
  napi_value promise = NULL;
  napi_value name = NULL;
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, label, NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, NULL, name, ExecuteInputWork, CompleteInputWork, job,
                             &job->work) != napi_ok) {
    if (job->work) napi_delete_async_work(env, job->work);
    free(job->text);
    free(job);
    return MakeBool(env, false);
  }
  if (napi_queue_async_work(env, job->work) != napi_ok) {
    napi_resolve_deferred(env, job->deferred, MakeBool(env, false));
    napi_delete_async_work(env, job->work);
    free(job->text);
    free(job);
    return promise;
  }
  return promise;
}

// ---------- 权限、窗口枚举、光标与 N-API 导出 ----------

static napi_value CheckPermissions(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value obj = NULL;
  napi_create_object(env, &obj);
  SetBoolProp(env, obj, "accessibility", AXIsProcessTrusted());
  SetBoolProp(env, obj, "screenRecording", CGPreflightScreenCaptureAccess());
  return obj;
}

static napi_value RequestPermissions(napi_env env, napi_callback_info info) {
  (void)info;
  NSDictionary *options = @{(__bridge id)kAXTrustedCheckOptionPrompt : @YES};
  bool axTrusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
  bool screenTrusted = CGRequestScreenCaptureAccess();
  napi_value obj = NULL;
  napi_create_object(env, &obj);
  SetBoolProp(env, obj, "accessibility", axTrusted);
  SetBoolProp(env, obj, "screenRecording", screenTrusted);
  return obj;
}

static napi_value ListWindows(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value array = NULL;
  napi_create_array(env, &array);
  @autoreleasepool {
    @try {
      pid_t frontPid = CurrentFrontmostPid();
      CFArrayRef rawList = CGWindowListCopyWindowInfo(
          kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
      if (!rawList) return array;
      NSArray *windows = (__bridge_transfer NSArray *)rawList;
      uint32_t outIndex = 0;
      for (NSDictionary *entry in windows) {
        NSNumber *layerNum = entry[(__bridge NSString *)kCGWindowLayer];
        int layer = layerNum ? layerNum.intValue : 0;
        if (!IsTrackedWindowLayer(layer)) continue;
        NSNumber *alphaNum = entry[(__bridge NSString *)kCGWindowAlpha];
        if (alphaNum && alphaNum.doubleValue <= 0.01) continue;
        NSDictionary *boundsDict = entry[(__bridge NSString *)kCGWindowBounds];
        CGRect rect = CGRectZero;
        if (!boundsDict || !CGRectMakeWithDictionaryRepresentation(
                               (__bridge CFDictionaryRef)boundsDict, &rect)) {
          continue;
        }
        if (rect.size.width < 16.0 || rect.size.height < 16.0) continue;
        NSNumber *widNum = entry[(__bridge NSString *)kCGWindowNumber];
        NSNumber *pidNum = entry[(__bridge NSString *)kCGWindowOwnerPID];
        NSString *ownerName = entry[(__bridge NSString *)kCGWindowOwnerName] ?: @"";
        NSString *title = entry[(__bridge NSString *)kCGWindowName] ?: @"";
        pid_t pid = pidNum ? (pid_t)pidNum.intValue : 0;
        NSRunningApplication *app =
            pid > 0 ? [NSRunningApplication runningApplicationWithProcessIdentifier:pid] : nil;
        NSString *bundleId = app.bundleIdentifier ?: @"";

        napi_value item = NULL;
        napi_create_object(env, &item);
        SetNumberProp(env, item, "windowId", widNum ? widNum.doubleValue : 0);
        SetNumberProp(env, item, "pid", (double)pid);
        SetStringProp(env, item, "appName", ownerName);
        SetStringProp(env, item, "bundleId", bundleId);
        SetStringProp(env, item, "title", title);
        SetNumberProp(env, item, "layer", (double)layer);
        SetBoolProp(env, item, "isFrontmost", pid > 0 && pid == frontPid);
        napi_set_named_property(env, item, "bounds", MakeRectObj(env, rect));
        napi_set_element(env, array, outIndex++, item);
      }
    } @catch (NSException *ex) {
      (void)ex;
    }
  }
  return array;
}

static napi_value FocusWindow(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  int32_t pid = 0, windowId = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 ||
      !ReadInt32Arg(env, argv[0], &pid) || pid <= 0 || pid == getpid()) {
    return MakeBool(env, false);
  }
  if (argc >= 2) ReadInt32Arg(env, argv[1], &windowId);
  RequestActivatePidAsync((pid_t)pid);
  if (windowId > 0) RaiseTargetAxWindow(pid, windowId);
  return MakeBool(env, true);
}

static napi_value GetCursorPosition(napi_env env, napi_callback_info info) {
  (void)info;
  CGPoint loc = ReadCurrentCursor();
  napi_value obj = NULL;
  napi_create_object(env, &obj);
  SetNumberProp(env, obj, "x", loc.x);
  SetNumberProp(env, obj, "y", loc.y);
  return obj;
}

static napi_value MouseMove(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  double x = 0, y = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2 ||
      !ReadDoubleArg(env, argv[0], &x) || !ReadDoubleArg(env, argv[1], &y)) {
    return MakeBool(env, false);
  }
  CGEventSourceRef src = CreateFastEventSource();
  CGEventRef move =
      CGEventCreateMouseEvent(src, kCGEventMouseMoved, CGPointMake(x, y), kCGMouseButtonLeft);
  if (move) {
    PostHidEvent(move);
    CFRelease(move);
  }
  if (src) CFRelease(src);
  return MakeBool(env, move != NULL);
}

static napi_value ParseClickWork(napi_env env, napi_callback_info info, InputWork *out) {
  size_t argc = 8;
  napi_value argv[8];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2 ||
      !ReadDoubleArg(env, argv[0], &out->x) || !ReadDoubleArg(env, argv[1], &out->y)) {
    napi_throw_type_error(env, NULL, "mouseClick 需要提供有限坐标 (x, y)");
    return NULL;
  }
  out->kind = kOpMouseClick;
  out->b = 1;
  if (argc >= 3) ReadInt32Arg(env, argv[2], &out->a);
  if (argc >= 4) ReadInt32Arg(env, argv[3], &out->b);
  if (argc >= 5) ReadInt32Arg(env, argv[4], &out->c);
  if (argc >= 6) ReadInt32Arg(env, argv[5], &out->targetPid);
  if (argc >= 7) ReadInt32Arg(env, argv[6], &out->targetWindowId);
  if (argc >= 8) ReadBoolArg(env, argv[7], &out->flag);
  return MakeBool(env, true);
}

static napi_value MouseClick(napi_env env, napi_callback_info info) {
  InputWork job = {0};
  if (!ParseClickWork(env, info, &job)) return NULL;
  return MakeBool(env, RunMouseClickBlocking(&job));
}

static napi_value MouseClickAsync(napi_env env, napi_callback_info info) {
  InputWork *job = (InputWork *)calloc(1, sizeof(InputWork));
  if (!job) return MakeBool(env, false);
  if (!ParseClickWork(env, info, job)) {
    free(job);
    return NULL;
  }
  return QueueInputWork(env, job, "mydsh.mouseClick");
}

static napi_value ParseDragWork(napi_env env, napi_callback_info info, InputWork *out) {
  size_t argc = 8;
  napi_value argv[8];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 4 ||
      !ReadDoubleArg(env, argv[0], &out->x) || !ReadDoubleArg(env, argv[1], &out->y) ||
      !ReadDoubleArg(env, argv[2], &out->tx) || !ReadDoubleArg(env, argv[3], &out->ty)) {
    napi_throw_type_error(env, NULL, "mouseDrag 需要起点与终点坐标");
    return NULL;
  }
  out->kind = kOpMouseDrag;
  out->a = 12;
  if (argc >= 5) ReadInt32Arg(env, argv[4], &out->a);
  if (argc >= 6) ReadInt32Arg(env, argv[5], &out->targetPid);
  if (argc >= 7) ReadInt32Arg(env, argv[6], &out->targetWindowId);
  if (argc >= 8) ReadBoolArg(env, argv[7], &out->flag);
  return MakeBool(env, true);
}

static napi_value MouseDrag(napi_env env, napi_callback_info info) {
  InputWork job = {0};
  if (!ParseDragWork(env, info, &job)) return NULL;
  return MakeBool(env, RunMouseDragBlocking(&job));
}

static napi_value MouseDragAsync(napi_env env, napi_callback_info info) {
  InputWork *job = (InputWork *)calloc(1, sizeof(InputWork));
  if (!job) return MakeBool(env, false);
  if (!ParseDragWork(env, info, job)) {
    free(job);
    return NULL;
  }
  return QueueInputWork(env, job, "mydsh.mouseDrag");
}

static napi_value ParseScrollWork(napi_env env, napi_callback_info info, InputWork *out) {
  size_t argc = 7;
  napi_value argv[7];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 4 ||
      !ReadDoubleArg(env, argv[0], &out->x) || !ReadDoubleArg(env, argv[1], &out->y) ||
      !ReadInt32Arg(env, argv[2], &out->a) || !ReadInt32Arg(env, argv[3], &out->b)) {
    napi_throw_type_error(env, NULL, "mouseScroll 需要坐标与滚动偏移量");
    return NULL;
  }
  out->kind = kOpMouseScroll;
  if (argc >= 5) ReadInt32Arg(env, argv[4], &out->targetPid);
  if (argc >= 6) ReadInt32Arg(env, argv[5], &out->targetWindowId);
  if (argc >= 7) ReadBoolArg(env, argv[6], &out->flag);
  return MakeBool(env, true);
}

static napi_value MouseScroll(napi_env env, napi_callback_info info) {
  InputWork job = {0};
  if (!ParseScrollWork(env, info, &job)) return NULL;
  return MakeBool(env, RunMouseScrollBlocking(&job));
}

static napi_value MouseScrollAsync(napi_env env, napi_callback_info info) {
  InputWork *job = (InputWork *)calloc(1, sizeof(InputWork));
  if (!job) return MakeBool(env, false);
  if (!ParseScrollWork(env, info, job)) {
    free(job);
    return NULL;
  }
  return QueueInputWork(env, job, "mydsh.mouseScroll");
}

static napi_value ParseKeyTapWork(napi_env env, napi_callback_info info, InputWork *out) {
  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 ||
      !ReadInt32Arg(env, argv[0], &out->a) || out->a < 0 || out->a > 255) {
    napi_throw_type_error(env, NULL, "keyTap 需要有效 macOS 虚拟键码");
    return NULL;
  }
  out->kind = kOpKeyTap;
  if (argc >= 2) ReadInt32Arg(env, argv[1], &out->b);
  if (argc >= 3) ReadInt32Arg(env, argv[2], &out->targetPid);
  if (argc >= 4) ReadBoolArg(env, argv[3], &out->flag);
  return MakeBool(env, true);
}

static napi_value KeyTap(napi_env env, napi_callback_info info) {
  InputWork job = {0};
  if (!ParseKeyTapWork(env, info, &job)) return NULL;
  return MakeBool(env, RunKeyTapBlocking(&job));
}

static napi_value KeyTapAsync(napi_env env, napi_callback_info info) {
  InputWork *job = (InputWork *)calloc(1, sizeof(InputWork));
  if (!job) return MakeBool(env, false);
  if (!ParseKeyTapWork(env, info, job)) {
    free(job);
    return NULL;
  }
  return QueueInputWork(env, job, "mydsh.keyTap");
}

static napi_value AxPressAt(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int32_t pid = 0;
  double x = 0, y = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3 ||
      !ReadInt32Arg(env, argv[0], &pid) || !ReadDoubleArg(env, argv[1], &x) ||
      !ReadDoubleArg(env, argv[2], &y)) {
    return MakeBool(env, false);
  }
  return MakeBool(env, RunAxPressBlocking(pid, x, y));
}

static napi_value AxPressAtAsync(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  InputWork *job = (InputWork *)calloc(1, sizeof(InputWork));
  if (!job) return MakeBool(env, false);
  job->kind = kOpAxPress;
  double x = 0, y = 0;
  int32_t pid = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc >= 3 &&
      ReadInt32Arg(env, argv[0], &pid) && ReadDoubleArg(env, argv[1], &x) &&
      ReadDoubleArg(env, argv[2], &y)) {
    job->targetPid = pid;
    job->x = x;
    job->y = y;
  }
  return QueueInputWork(env, job, "mydsh.axPressAt");
}

static napi_value AxSetTextAt(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  int32_t pid = 0;
  double x = NAN, y = NAN;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 4 ||
      !ReadInt32Arg(env, argv[0], &pid)) {
    return MakeBool(env, false);
  }
  double rx = NAN, ry = NAN;
  if (ReadDoubleArg(env, argv[1], &rx) && ReadDoubleArg(env, argv[2], &ry)) {
    x = rx;
    y = ry;
  }
  size_t len = 0;
  if (napi_get_value_string_utf8(env, argv[3], NULL, 0, &len) != napi_ok) {
    return MakeBool(env, false);
  }
  char *buf = (char *)calloc(len + 1, 1);
  if (!buf) return MakeBool(env, false);
  napi_get_value_string_utf8(env, argv[3], buf, len + 1, &len);
  bool ok = RunAxSetTextBlocking(pid, x, y, buf, len);
  free(buf);
  return MakeBool(env, ok);
}

static napi_value AxSetTextAtAsync(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  InputWork *job = (InputWork *)calloc(1, sizeof(InputWork));
  if (!job) return MakeBool(env, false);
  job->kind = kOpAxSetText;
  job->x = NAN;
  job->y = NAN;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc >= 4 &&
      ReadInt32Arg(env, argv[0], &job->targetPid)) {
    double rx = NAN, ry = NAN;
    if (ReadDoubleArg(env, argv[1], &rx) && ReadDoubleArg(env, argv[2], &ry)) {
      job->x = rx;
      job->y = ry;
    }
    size_t len = 0;
    if (napi_get_value_string_utf8(env, argv[3], NULL, 0, &len) == napi_ok) {
      job->text = (char *)calloc(len + 1, 1);
      if (job->text) {
        napi_get_value_string_utf8(env, argv[3], job->text, len + 1, &job->textLen);
      }
    }
  }
  return QueueInputWork(env, job, "mydsh.axSetTextAt");
}

static napi_value TypeText(napi_env env, napi_callback_info info) {
  (void)info;
  return MakeBool(env, false);
}

static napi_value ReleaseAllModifiers(napi_env env, napi_callback_info info) {
  (void)info;
  static const CGKeyCode kModifierKeys[] = {55, 54, 56, 60, 58, 61, 59, 62};
  for (size_t i = 0; i < sizeof(kModifierKeys) / sizeof(kModifierKeys[0]); i++) {
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, kModifierKeys[i], false);
    if (up) {
      CGEventSetFlags(up, 0);
      PostHidEvent(up);
      CFRelease(up);
    }
  }
  return MakeBool(env, true);
}

static napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor props[] = {
      {"checkPermissions", NULL, CheckPermissions, NULL, NULL, NULL, napi_default, NULL},
      {"requestPermissions", NULL, RequestPermissions, NULL, NULL, NULL, napi_default, NULL},
      {"listWindows", NULL, ListWindows, NULL, NULL, NULL, napi_default, NULL},
      {"focusWindow", NULL, FocusWindow, NULL, NULL, NULL, napi_default, NULL},
      {"captureWindowPng", NULL, CaptureWindowPng, NULL, NULL, NULL, napi_default, NULL},
      {"captureWindowPngAsync", NULL, CaptureWindowPngAsync, NULL, NULL, NULL, napi_default, NULL},
      {"getUiTree", NULL, GetUiTree, NULL, NULL, NULL, napi_default, NULL},
      {"getUiTreeAsync", NULL, GetUiTreeAsync, NULL, NULL, NULL, napi_default, NULL},
      {"axPressAt", NULL, AxPressAt, NULL, NULL, NULL, napi_default, NULL},
      {"axPressAtAsync", NULL, AxPressAtAsync, NULL, NULL, NULL, napi_default, NULL},
      {"axSetTextAt", NULL, AxSetTextAt, NULL, NULL, NULL, napi_default, NULL},
      {"axSetTextAtAsync", NULL, AxSetTextAtAsync, NULL, NULL, NULL, napi_default, NULL},
      {"getCursorPosition", NULL, GetCursorPosition, NULL, NULL, NULL, napi_default, NULL},
      {"mouseMove", NULL, MouseMove, NULL, NULL, NULL, napi_default, NULL},
      {"mouseClick", NULL, MouseClick, NULL, NULL, NULL, napi_default, NULL},
      {"mouseClickAsync", NULL, MouseClickAsync, NULL, NULL, NULL, napi_default, NULL},
      {"mouseDrag", NULL, MouseDrag, NULL, NULL, NULL, napi_default, NULL},
      {"mouseDragAsync", NULL, MouseDragAsync, NULL, NULL, NULL, napi_default, NULL},
      {"mouseScroll", NULL, MouseScroll, NULL, NULL, NULL, napi_default, NULL},
      {"mouseScrollAsync", NULL, MouseScrollAsync, NULL, NULL, NULL, napi_default, NULL},
      {"keyTap", NULL, KeyTap, NULL, NULL, NULL, napi_default, NULL},
      {"keyTapAsync", NULL, KeyTapAsync, NULL, NULL, NULL, napi_default, NULL},
      {"typeText", NULL, TypeText, NULL, NULL, NULL, napi_default, NULL},
      {"releaseAllModifiers", NULL, ReleaseAllModifiers, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(mydsh_computer_use, Init)
