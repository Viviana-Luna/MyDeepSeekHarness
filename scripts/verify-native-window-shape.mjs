/* oxlint-disable no-await-in-loop -- 原生窗口状态按顺序改变，再读取系统区域与截图。 */
/**
 * 独立 Electron 窗口验证实际 Windows 裁切区域与原生缩放热区；所有浏览器存储位于临时目录。
 * 复用单个常驻 PowerShell 进程执行 Win32 检查与桌面抓帧，并在退出或失败时统一释放窗口与子进程。
 */
import { app, BrowserWindow, screen } from 'electron'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { installWindowBackground } from '../lib/main/window-background.js'
import { WINDOW_CORNER_RADIUS } from '../lib/main/window-shape.js'
import { windowClipStyle } from '../lib/shared/window.js'

const RESPONSE_PREFIX = 'MYDSH_AUDIT_RESPONSE:'
// 首次请求包含 PowerShell 冷启与 Add-Type 编译，在 CI + Defender 下需预留足够编译时间。
const INSPECTOR_REQUEST_TIMEOUT_MS = 45_000
const INSPECTOR_DISPOSE_TIMEOUT_MS = 1_500
// 复用常驻 PowerShell 后不再有每次 2s 左右的冷启缓冲，抓帧前留出 DWM 合成稳定时间。
const PIXEL_SETTLE_DELAY_MS = 350

const skipPixels =
  process.env.MYDSH_VERIFY_WINDOW_SKIP_PIXELS === '1' || process.argv.includes('--skip-pixels')
// 无独立 GPU 的 CI 虚拟机上启用硬件加速会触发 Chromium GPU 进程连续崩溃；
// 跳过桌面像素比对时关闭硬件加速改走软件渲染，完整保留原生几何、区域、命中与资源清理校验。
if (skipPixels) app.disableHardwareAcceleration()

const root =
  process.env.MYDSH_VERIFY_WINDOW_HOME ?? mkdtempSync(join(tmpdir(), 'mydsh-window-shape-'))
app.setPath('userData', join(root, 'electron'))
app.setPath('sessionData', join(root, 'electron'))
app.commandLine.appendSwitch(
  'force-device-scale-factor',
  process.env.MYDSH_VERIFY_WINDOW_SCALE ?? '1.5',
)
const nativeBackground = createRequire(import.meta.url)('../lib/main/window-background.node')

const SHAPE_AUDIT_SCRIPT = `$ErrorActionPreference = 'Stop'
$taskUtf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $taskUtf8; [Console]::OutputEncoding = $taskUtf8
$script:drawingLoaded = $false
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class MydshShapeAudit {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr window, IntPtr region);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
 [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr region, out Rect rect);
 [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int left,int top,int right,int bottom);
 [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr region,int x,int y);
 [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr value);
 public delegate bool InspectChild(IntPtr child,IntPtr data);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr window,InspectChild inspect,IntPtr data);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window,StringBuilder name,int maximum);
 public static IntPtr RendererWindow(IntPtr window) {
  IntPtr found=IntPtr.Zero;
  EnumChildWindows(window,(child,data)=>{var name=new StringBuilder(64);GetClassName(child,name,64);if(name.ToString()=="Chrome_RenderWidgetHostHWND"){found=child;return false;}return true;},IntPtr.Zero);
  return found;
 }
}
'@
function Invoke-MydshInspect([string]$HwndText, [double]$LogicalWidth) {
 $taskWindow=[IntPtr]::new([long]::Parse($HwndText))
 $taskPreviousDpi=[MydshShapeAudit]::SetThreadDpiAwarenessContext([MydshShapeAudit]::GetWindowDpiAwarenessContext($taskWindow))
 $taskRegion=[IntPtr]::Zero
 try {
  $taskRect=[MydshShapeAudit+Rect]::new()
  if(![MydshShapeAudit]::GetWindowRect($taskWindow,[ref]$taskRect)){throw '窗口矩形读取失败'}
  $taskWidth=$taskRect.Right-$taskRect.Left; $taskHeight=$taskRect.Bottom-$taskRect.Top
  $taskClient=[MydshShapeAudit+Rect]::new(); [void][MydshShapeAudit]::GetClientRect($taskWindow,[ref]$taskClient)
  $taskRegion=[MydshShapeAudit]::CreateRectRgn(0,0,0,0)
  $taskKind=[MydshShapeAudit]::GetWindowRgn($taskWindow,$taskRegion)
  $taskBox=[MydshShapeAudit+Rect]::new(); [void][MydshShapeAudit]::GetRgnBox($taskRegion,[ref]$taskBox)
  $taskLeftX=$taskRect.Left+2; $taskMidY=$taskRect.Top+[int]($taskHeight/2)
  $taskMidX=$taskRect.Left+[int]($taskWidth/2); $taskTopY=$taskRect.Top+2
  $taskLeftHit=[MydshShapeAudit]::SendMessage($taskWindow,0x84,[IntPtr]::Zero,[IntPtr]::new(($taskMidY -shl 16) -bor ($taskLeftX -band 65535))).ToInt32()
  $taskTopHit=[MydshShapeAudit]::SendMessage($taskWindow,0x84,[IntPtr]::Zero,[IntPtr]::new(($taskTopY -shl 16) -bor ($taskMidX -band 65535))).ToInt32()
  $taskInset=[int][Math]::Ceiling(6*$taskWidth/$LogicalWidth); $taskResizeHits=@()
  $taskChild=[MydshShapeAudit]::RendererWindow($taskWindow)
  foreach($taskPoint in @(@('左上',$taskInset,$taskInset,13),@('右上',($taskWidth-1-$taskInset),$taskInset,14),@('左下',$taskInset,($taskHeight-1-$taskInset),16),@('右下',($taskWidth-1-$taskInset),($taskHeight-1-$taskInset),17),@('左',$taskInset,[int]($taskHeight/2),10),@('右',($taskWidth-1-$taskInset),[int]($taskHeight/2),11),@('上',[int]($taskWidth/2),$taskInset,12),@('下',[int]($taskWidth/2),($taskHeight-1-$taskInset),15))) {
   $taskX=$taskRect.Left+$taskPoint[1]; $taskY=$taskRect.Top+$taskPoint[2]
   $taskHit=[MydshShapeAudit]::SendMessage($taskWindow,0x84,[IntPtr]::Zero,[IntPtr]::new(($taskY -shl 16) -bor ($taskX -band 65535))).ToInt32()
   $taskChildHit=0
   if($taskChild -ne [IntPtr]::Zero){$taskChildHit=[MydshShapeAudit]::SendMessage($taskChild,0x84,[IntPtr]::Zero,[IntPtr]::new(($taskY -shl 16) -bor ($taskX -band 65535))).ToInt32()}
   $taskResizeHits+=@{direction=$taskPoint[0];expected=$taskPoint[3];hit=$taskHit;childHit=$taskChildHit;inside=[MydshShapeAudit]::PtInRegion($taskRegion,$taskPoint[1],$taskPoint[2])}
  }
  return @{kind=$taskKind;leftHit=$taskLeftHit;topHit=$taskTopHit;resizeHits=$taskResizeHits;region=@{left=$taskBox.Left;top=$taskBox.Top;right=$taskBox.Right;bottom=$taskBox.Bottom};width=$taskWidth;height=$taskHeight;clientWidth=$taskClient.Right;clientHeight=$taskClient.Bottom;dpi=[MydshShapeAudit]::GetDpiForWindow($taskWindow);left=$taskRect.Left;top=$taskRect.Top;corner=[MydshShapeAudit]::PtInRegion($taskRegion,0,0);topMid=[MydshShapeAudit]::PtInRegion($taskRegion,[int]($taskWidth/2),0);rightMid=[MydshShapeAudit]::PtInRegion($taskRegion,$taskWidth-1,[int]($taskHeight/2));bottomCorner=[MydshShapeAudit]::PtInRegion($taskRegion,$taskWidth-1,$taskHeight-1)}
 } finally {
  if($taskRegion -ne [IntPtr]::Zero){[void][MydshShapeAudit]::DeleteObject($taskRegion)}
  if($taskPreviousDpi -ne [IntPtr]::Zero){[void][MydshShapeAudit]::SetThreadDpiAwarenessContext($taskPreviousDpi)}
 }
}
function Invoke-MydshCapture([string]$HwndText, [double]$Radius, [string]$Output) {
 if(-not $script:drawingLoaded){Add-Type -AssemblyName System.Drawing; $script:drawingLoaded=$true}
 $taskWindow=[IntPtr]::new([long]::Parse($HwndText))
 $taskPreviousDpi=[MydshShapeAudit]::SetThreadDpiAwarenessContext([MydshShapeAudit]::GetWindowDpiAwarenessContext($taskWindow))
 $taskBitmap=$null; $taskGraphics=$null
 try {
  $taskRect=[MydshShapeAudit+Rect]::new()
  if(![MydshShapeAudit]::GetWindowRect($taskWindow,[ref]$taskRect)){throw '窗口矩形读取失败'}
  $taskWidth=$taskRect.Right-$taskRect.Left; $taskHeight=$taskRect.Bottom-$taskRect.Top
  $taskBitmap=[Drawing.Bitmap]::new($taskWidth+24,$taskHeight+24)
  $taskGraphics=[Drawing.Graphics]::FromImage($taskBitmap)
  $taskGraphics.CopyFromScreen($taskRect.Left-12,$taskRect.Top-12,0,0,$taskBitmap.Size)
  $taskBitmap.Save($Output,[Drawing.Imaging.ImageFormat]::Png)
  $taskMaximumError=0
  foreach($taskSample in @(@(1,1),@(2,2),@(4,1),@(1,4))){
   foreach($taskCornerPoint in @(@($taskSample[0],$taskSample[1]),@(($taskWidth-1-$taskSample[0]),$taskSample[1]),@($taskSample[0],($taskHeight-1-$taskSample[1])),@(($taskWidth-1-$taskSample[0]),($taskHeight-1-$taskSample[1])))){
    $taskColor=$taskBitmap.GetPixel($taskCornerPoint[0]+12,$taskCornerPoint[1]+12)
    $taskMaximumError=[Math]::Max($taskMaximumError,[Math]::Max([Math]::Abs($taskColor.R-24),[Math]::Max([Math]::Abs($taskColor.G-190),[Math]::Abs($taskColor.B-123))))
   }
  }
  $taskCanvas=$taskBitmap.GetPixel([int]($taskWidth/2)+12,14); $taskRadius=[double]$Radius
  $taskArcOutsideError=0; $taskArcAntialias=@(0,0,0,0); $taskMissingCoverage=0
  for($taskY=0;$taskY -lt [Math]::Ceiling($taskRadius)+2;$taskY++){
   for($taskX=0;$taskX -lt [Math]::Ceiling($taskRadius)+2;$taskX++){
    $taskMinimum=[Math]::Sqrt([Math]::Pow([Math]::Max(0.0,$taskRadius-$taskX-1.0),2)+[Math]::Pow([Math]::Max(0.0,$taskRadius-$taskY-1.0),2))-$taskRadius
    $taskMaximum=[Math]::Sqrt([Math]::Pow([Math]::Max(0.0,$taskRadius-$taskX),2)+[Math]::Pow([Math]::Max(0.0,$taskRadius-$taskY),2))-$taskRadius
    $taskArcPoints=@(@($taskX,$taskY),@(($taskWidth-1-$taskX),$taskY),@($taskX,($taskHeight-1-$taskY)),@(($taskWidth-1-$taskX),($taskHeight-1-$taskY)))
    for($taskCorner=0;$taskCorner -lt 4;$taskCorner++){
     $taskColor=$taskBitmap.GetPixel($taskArcPoints[$taskCorner][0]+12,$taskArcPoints[$taskCorner][1]+12)
     $taskError=[Math]::Max([Math]::Abs($taskColor.R-24),[Math]::Max([Math]::Abs($taskColor.G-190),[Math]::Abs($taskColor.B-123)))
     $taskFullError=[Math]::Max([Math]::Abs($taskColor.R-$taskCanvas.R),[Math]::Max([Math]::Abs($taskColor.G-$taskCanvas.G),[Math]::Abs($taskColor.B-$taskCanvas.B)))
     if($taskMinimum -gt .05){$taskArcOutsideError=[Math]::Max($taskArcOutsideError,$taskError)}
     if($taskMinimum -le 0 -and $taskMaximum -ge 0 -and $taskError -gt 5 -and $taskFullError -gt 5){$taskArcAntialias[$taskCorner]++}
     if($taskMinimum -lt -.3 -and $taskMaximum -ge 0 -and $taskError -le 2){$taskMissingCoverage++}
    }
   }
  }
  $taskOutsideError=0
  for($taskDistance=1;$taskDistance -le 8;$taskDistance++){
   foreach($taskEdgePoint in @(@([int]($taskWidth/2),(-$taskDistance)),@([int]($taskWidth/2),($taskHeight-1+$taskDistance)),@((-$taskDistance),[int]($taskHeight/2)),@(($taskWidth-1+$taskDistance),[int]($taskHeight/2)))){
    $taskColor=$taskBitmap.GetPixel($taskEdgePoint[0]+12,$taskEdgePoint[1]+12)
    $taskOutsideError=[Math]::Max($taskOutsideError,[Math]::Max([Math]::Abs($taskColor.R-24),[Math]::Max([Math]::Abs($taskColor.G-190),[Math]::Abs($taskColor.B-123))))
   }
  }
  $taskEdgeColors=@()
  foreach($taskEdgePoint in @(@([int]($taskWidth/2),0),@([int]($taskWidth/2),($taskHeight-1)),@(0,[int]($taskHeight/2)),@(($taskWidth-1),[int]($taskHeight/2)))){
   $taskColor=$taskBitmap.GetPixel($taskEdgePoint[0]+12,$taskEdgePoint[1]+12)
   $taskEdgeColors+=@($taskColor.R,$taskColor.G,$taskColor.B)
  }
  return @{left=$taskRect.Left;top=$taskRect.Top;width=$taskWidth;height=$taskHeight;maximumCornerError=$taskMaximumError;maximumOutsideError=$taskOutsideError;maximumArcOutsideError=$taskArcOutsideError;arcAntialias=$taskArcAntialias;missingArcCoverage=$taskMissingCoverage;edge=$taskEdgeColors;canvas=@($taskCanvas.R,$taskCanvas.G,$taskCanvas.B);path=$Output}
 } finally {
  if($null -ne $taskGraphics){$taskGraphics.Dispose()}; if($null -ne $taskBitmap){$taskBitmap.Dispose()}
  if($taskPreviousDpi -ne [IntPtr]::Zero){[void][MydshShapeAudit]::SetThreadDpiAwarenessContext($taskPreviousDpi)}
 }
}
while($null -ne ($taskLine=[Console]::In.ReadLine())){
 if($taskLine -eq ''){continue}
 try {
  $taskRequest=$taskLine | ConvertFrom-Json
  if($taskRequest.action -eq 'exit'){break}
  if($taskRequest.action -eq 'inspect'){$taskData=Invoke-MydshInspect -HwndText ([string]$taskRequest.hwnd) -LogicalWidth ([double]$taskRequest.logicalWidth)}
  elseif($taskRequest.action -eq 'capture'){$taskData=Invoke-MydshCapture -HwndText ([string]$taskRequest.hwnd) -Radius ([double]$taskRequest.radius) -Output ([string]$taskRequest.output)}
  else{throw ('未知检查动作：'+$taskRequest.action)}
  $taskResponse=@{ok=$true;data=$taskData}
 } catch {$taskResponse=@{ok=$false;error=$_.Exception.Message}}
 [Console]::Out.WriteLine('${RESPONSE_PREFIX}'+($taskResponse | ConvertTo-Json -Depth 6 -Compress)); [Console]::Out.Flush()
}`

/** 发送退出指令并等待常驻 PowerShell 进程结束，超时后强制终止避免进程泄漏。 */
async function stopInspectorProcess(child, isExited) {
  if (isExited()) return
  try {
    if (!child.stdin.destroyed) child.stdin.end(`${JSON.stringify({ action: 'exit' })}\n`)
  } catch {
    // 管道已关闭时忽略写入异常，后续按超时兜底终止子进程。
  }
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      if (!isExited()) child.kill()
      resolve()
    }, INSPECTOR_DISPOSE_TIMEOUT_MS)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** 解析常驻 PowerShell 返回的单行响应，转换为结果值或中文错误。 */
function parseInspectorLine(rawLine) {
  const line = rawLine.replace(/\r$/u, '')
  if (!line.startsWith(RESPONSE_PREFIX)) return undefined
  let response
  try {
    response = JSON.parse(line.slice(RESPONSE_PREFIX.length))
  } catch (error) {
    return { error: new Error(`无法解析原生窗口检查输出：${String(error)}`) }
  }
  return response.ok
    ? { data: response.data }
    : { error: new Error(`原生窗口检查失败：${response.error}`) }
}

/** 启动并复用单个常驻 PowerShell 检查进程，避免重复触发 csc.exe 编译；调用方负责 dispose()。 */
async function createNativeInspector(workDir) {
  const scriptPath = join(workDir, 'shape-audit.ps1')
  // PowerShell 5.1 仅在存在 UTF-8 BOM 时按 UTF-8 解析 .ps1 脚本中的中文字符。
  await writeFile(scriptPath, `\uFEFF${SHAPE_AUDIT_SCRIPT}`, 'utf8')
  const args = ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File']
  const child = spawn('powershell.exe', [...args, scriptPath], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let pending = null
  let closedError = null
  let exited = false
  let stdoutBuffer = ''
  let stderrBuffer = ''
  const failActive = error => {
    closedError ??= error
    if (pending === null) return
    const current = pending
    pending = null
    clearTimeout(current.timer)
    current.reject(error)
  }
  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk
    const lines = stdoutBuffer.split('\n')
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const parsed = parseInspectorLine(line)
      if (parsed === undefined || pending === null) continue
      const current = pending
      pending = null
      clearTimeout(current.timer)
      if (parsed.error) current.reject(parsed.error)
      else current.resolve(parsed.data)
    }
  })
  child.stderr.on('data', chunk => {
    stderrBuffer = (stderrBuffer + chunk).slice(-8192)
  })
  child.stdin.on('error', error =>
    failActive(new Error(`写入原生窗口检查管道失败：${error.message}`)),
  )
  child.once('error', error => {
    exited = true
    failActive(new Error(`无法启动原生窗口检查进程：${error.message}`))
  })
  child.once('exit', (code, signal) => {
    exited = true
    const detail = stderrBuffer.trim()
    const summary = detail ? `${code ?? signal}（${detail}）` : String(code ?? signal)
    failActive(new Error(`原生窗口检查进程提前退出：${summary}`))
  })
  const send = payload => {
    if (closedError !== null) return Promise.reject(closedError)
    if (pending !== null) return Promise.reject(new Error('原生窗口检查请求不能并发执行'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending === null) return
        pending = null
        child.kill()
        reject(
          new Error(`原生窗口检查超时（${INSPECTOR_REQUEST_TIMEOUT_MS}ms）：${payload.action}`),
        )
      }, INSPECTOR_REQUEST_TIMEOUT_MS)
      pending = { resolve, reject, timer }
      child.stdin.write(`${JSON.stringify(payload)}\n`)
    })
  }
  return {
    inspect: (hwnd, logicalWidth) => send({ action: 'inspect', hwnd, logicalWidth }),
    capture: ({ hwnd, radius, output }) => send({ action: 'capture', hwnd, radius, output }),
    dispose: async () => {
      failActive(new Error('原生窗口检查进程已释放'))
      await stopInspectorProcess(child, () => exited)
    },
  }
}

/** 在超时上限内周期性轮询窗口状态，避免慢虚拟机上固定短延时造成竞态。 */
async function waitUntil(sample, isReady, timeoutMs = 5_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs
  let latest = await sample()
  while (!isReady(latest) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs))
    latest = await sample()
  }
  return latest
}

/** 将 HTML 编码为可加载的 data URL。 */
const htmlUrl = html => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`

/** 等待页面连续完成两次动画帧绘制，确保样式裁剪与底色已提交给合成器。 */
async function waitForNextFrames(targetWindow) {
  await targetWindow.webContents.executeJavaScript(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  )
}

/** 判断采样结果是否仍命中任意原生缩放方向（HTLEFT..HTBOTTOMRIGHT）。 */
function hasResizeHit(report) {
  return [report.leftHit, report.topHit, ...report.resizeHits.map(point => point.hit)].some(
    hit => hit >= 10 && hit <= 17,
  )
}

/** 判断最大化或全屏后自定义裁切区域与缩放区是否均已释放。 */
const isShapeReleased = report => report.kind === 0 && !hasResizeHit(report)

/** 判断原生圆角区域是否满足四角裁切且四边中点可见的契约。 */
const isRoundedRegion = report =>
  report.kind === 3 && !report.corner && !report.bottomCorner && report.topMid && report.rightMid

/** 判断父子 HWND 的八方向原生缩放热区与子窗口穿透钩子是否全部就绪。 */
const isResizeReady = report =>
  nativeBackground.resizeChildCount() >= 1 &&
  report.resizeHits.every(
    point => point.inside && point.hit === point.expected && point.childHit === -1,
  )

/** 在本地完整桌面模式下抓取并校验当前窗口四角、外缘与圆弧抗锯齿像素。 */
async function captureWindowPixels({ win, hwnd, background, inspector, captureRoot, name }) {
  const viewport = await win.webContents.executeJavaScript(
    '({ width: document.body.getBoundingClientRect().width, height: document.body.getBoundingClientRect().height, scale: devicePixelRatio })',
  )
  const nativeClip = background.readClip()
  const mask = windowClipStyle(
    {
      canvasComposition: nativeClip === undefined ? 'opaque' : 'acrylic',
      canvasClip: nativeClip,
      cornerRadius: background.readCornerRadius(),
    },
    viewport,
  )
  await win.webContents.executeJavaScript(
    `document.body.style.clipPath = ${JSON.stringify(`inset(0 ${mask.right}px ${mask.bottom}px 0 round ${mask.radius}px)`)}`,
  )
  await waitForNextFrames(win)
  await new Promise(resolve => setTimeout(resolve, PIXEL_SETTLE_DELAY_MS))
  const page = await win.webContents.executeJavaScript(
    '({ dpr: devicePixelRatio, width: innerWidth, height: innerHeight, body: document.body.getBoundingClientRect().toJSON(), clip: getComputedStyle(document.body).clipPath })',
  )
  console.log(
    '圆弧绘制尺寸：',
    JSON.stringify({ name, size: win.getSize(), contentSize: win.getContentSize(), page }),
  )
  const report = await inspector.capture({
    hwnd,
    radius: nativeClip?.radius ?? WINDOW_CORNER_RADIUS,
    output: join(captureRoot, `${name}.png`),
  })
  if (report.maximumCornerError > 2)
    throw new Error('原生背景在圆角外留下了像素：' + JSON.stringify(report))
  if (report.maximumOutsideError > 2)
    throw new Error('原生边缘向窗口外模糊扩散：' + JSON.stringify(report))
  if (nativeClip !== undefined && report.maximumArcOutsideError > 2)
    throw new Error('圆弧外的完整像素发生颜色泄漏：' + JSON.stringify(report))
  if (
    ['light', 'dark'].includes(name) &&
    (report.missingArcCoverage !== 0 ||
      report.arcAntialias.some(count => count < WINDOW_CORNER_RADIUS * 0.75))
  ) {
    throw new Error('圆弧的抗锯齿覆盖被截断：' + JSON.stringify(report))
  }
  console.log('原生可见边缘：', JSON.stringify({ name, ...report }))
  return report
}

let win, background, underlay, inspector
async function main() {
  try {
    await app.whenReady()
    console.log(
      '原生圆角验收模式：',
      skipPixels ? '无 GPU 原生几何模式（跳过桌面像素）' : '完整桌面像素模式',
    )
    // 显式指定左上角且关闭居中，避免 1024×720 工作区叠加 1.5x 缩放时被 Electron 自动压扁。
    win = new BrowserWindow({
      x: 0,
      y: 0,
      width: 680,
      height: 580,
      center: false,
      resizable: false,
      frame: false,
      thickFrame: false,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    background = installWindowBackground(win, process.platform, error => {
      throw error
    })
    win.setBackgroundMaterial('acrylic')
    win.setBackgroundColor('#00000000')
    background.setEnabled(true)
    await win.loadURL(
      htmlUrl(
        `<html><body style="margin:0;clip-path:inset(0 round ${WINDOW_CORNER_RADIUS}px);background:#1b1c2066;display:grid;place-items:center;height:100vh"><div style="width:90%;height:90%;border-radius:18px;border:1px solid #6c7177;background:#1b1c20;color:white;font:18px sans-serif;display:grid;place-items:center">MyDSH 原生圆角验收</div></body></html>`,
      ),
    )
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE().toString()
    inspector = await createNativeInspector(root)
    const read = () => inspector.inspect(hwnd, win.getSize()[0])
    const checkResize = report => {
      if (!isResizeReady(report))
        throw new Error(
          '四边与可见圆弧没有完整命中八个缩放方向：' + JSON.stringify(report.resizeHits),
        )
    }
    const startup = await read()
    if (startup.resizeHits.some(point => point.hit >= 10 && point.hit <= 17))
      throw new Error('固定启动小窗错误地启用了缩放：' + JSON.stringify(startup))
    win.setResizable(true)
    win.setMaximizable(true)
    console.log(
      '原生窗口能力：',
      JSON.stringify({
        resizable: win.isResizable(),
        maximizable: win.isMaximizable(),
        minimizable: win.isMinimizable(),
      }),
    )
    if (!win.isMaximizable() || !win.isMinimizable() || nativeBackground.resizeCount() !== 1)
      throw new Error('从启动小窗进入工作台后没有恢复原生窗口能力')
    const reports = []
    for (const [width, height] of [
      [1280, 800],
      [1600, 1000],
      [680, 580],
    ]) {
      win.setSize(width, height)
      const report = await waitUntil(
        read,
        current =>
          isRoundedRegion(current) &&
          current.leftHit === 10 &&
          current.topHit === 12 &&
          isResizeReady(current),
      )
      const snapshot = {
        size: win.getSize(),
        bounds: win.getBounds(),
        content: win.getContentBounds(),
        native: report,
      }
      console.log('原生圆角尺寸：', JSON.stringify(snapshot))
      if (!isRoundedRegion(report))
        throw new Error('实际原生窗口区域不符合圆角契约：' + JSON.stringify(report))
      if (report.leftHit !== 10 || report.topHit !== 12)
        throw new Error('自定义圆角窗口失去原生边缘缩放：' + JSON.stringify(report))
      checkResize(report)
      reports.push({ size: [width, height], ...report })
    }
    win.maximize()
    const maximized = await waitUntil(read, isShapeReleased)
    if (maximized.kind !== 0)
      throw new Error('最大化后没有释放自定义裁切区域：' + JSON.stringify(maximized))
    if (hasResizeHit(maximized))
      throw new Error('最大化后仍保留窗口缩放区：' + JSON.stringify(maximized))
    win.unmaximize()
    win.setSize(1280, 800)
    win.show()
    win.focus()
    const restored = await waitUntil(
      read,
      c => !win.isMaximized() && c.kind === 3 && !c.corner && c.topMid && c.rightMid,
    )
    if (restored.kind !== 3 || restored.corner || !restored.topMid || !restored.rightMid)
      throw new Error('还原后没有恢复完整自定义圆角：' + JSON.stringify(restored))
    win.minimize()
    if (!(await waitUntil(() => win.isMinimized(), Boolean)))
      throw new Error('原生窗口未响应最小化')
    win.restore()
    const afterMinimize = await waitUntil(
      read,
      c => !win.isMinimized() && c.kind === 3 && c.rightMid,
    )
    if (win.isMinimized() || afterMinimize.kind !== 3 || !afterMinimize.rightMid)
      throw new Error('最小化还原后没有恢复圆角：' + JSON.stringify(afterMinimize))
    win.setFullScreen(true)
    const fullScreen = await waitUntil(read, isShapeReleased)
    if (fullScreen.kind !== 0)
      throw new Error('全屏后没有释放裁切区域：' + JSON.stringify(fullScreen))
    if (hasResizeHit(fullScreen))
      throw new Error('全屏后仍保留窗口缩放区：' + JSON.stringify(fullScreen))
    win.setFullScreen(false)
    const afterFullScreen = await waitUntil(
      read,
      c => !win.isFullScreen() && c.kind === 3 && c.rightMid,
    )
    if (win.isFullScreen() || afterFullScreen.kind !== 3 || !afterFullScreen.rightMid)
      throw new Error('退出全屏后没有恢复圆角：' + JSON.stringify(afterFullScreen))

    const visible = []
    const captureRoot = process.env.MYDSH_VERIFY_WINDOW_CAPTURE_ROOT ?? root
    const pixels = name =>
      captureWindowPixels({ win, hwnd, background, inspector, captureRoot, name })
    if (skipPixels) {
      if (nativeBackground.activeCount() !== 1)
        throw new Error('背景状态更新没有保留唯一的原生视觉')
    } else {
      // 用本次拥有的对比底窗检查实际桌面像素；GetWindowRgn 正确并不表示 DWM 背景也被裁掉。
      const area = screen.getPrimaryDisplay().workArea
      win.setSize(360, 240)
      win.setPosition(area.x + 70, area.y + 70)
      underlay = new BrowserWindow({
        x: area.x + 50,
        y: area.y + 50,
        width: 400,
        height: 280,
        center: false,
        frame: false,
        thickFrame: false,
        focusable: false,
        alwaysOnTop: true,
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      })
      await underlay.loadURL(htmlUrl('<body style="margin:0;background:#18be7b"></body>'))
      underlay.showInactive()
      // 无焦点显示不能保证高于其他置顶窗口；先抬高底窗，再抬高本次测试窗口。
      underlay.moveTop()
      await waitForNextFrames(underlay)
      const underlayHwnd = underlay.getNativeWindowHandle().readBigUInt64LE().toString()
      const { left, top, width, height } = await inspector.inspect(
        underlayHwnd,
        underlay.getSize()[0],
      )
      console.log(
        '对比底窗几何：',
        JSON.stringify({
          size: underlay.getSize(),
          bounds: underlay.getBounds(),
          native: { left, top, width, height },
        }),
      )
      win.setAlwaysOnTop(true)
      win.moveTop()
      for (const [name, canvas, surface] of [
        ['light', '#f3f4f677', '#fff'],
        ['dark', '#10111377', '#1b1c20'],
        ['clear', 'transparent', '#fff'],
      ]) {
        await win.loadURL(
          htmlUrl(
            `<html><meta charset="utf-8"><body style="margin:0;height:100vh;clip-path:inset(0 round ${WINDOW_CORNER_RADIUS}px);background:transparent"><div style="position:fixed;inset:0;background:${canvas}"></div><div style="position:absolute;inset:10px;border-radius:18px;border:1px solid #88919b;background:${surface};color:#567;font:14px sans-serif;padding:20px">MyDSH 原生圆角验收</div></body></html>`,
          ),
        )
        visible.push(await pixels(name))
        if (nativeBackground.activeCount() !== 1)
          throw new Error('背景状态更新没有保留唯一的原生视觉')
      }
      if (visible[0].canvas.every((value, i) => value === visible[2].canvas[i]))
        throw new Error('画布透明度未改变真实原生背景')
      if (Math.max(...visible[2].canvas.map((value, i) => Math.abs(value - [24, 190, 123][i]))) > 2)
        throw new Error('高透画布没有显示原生窗口后方的内容')
    }
    // 实色降级与再次启用：完整模式同时校验四角像素，无 GPU 模式继续校验原生背景计数与 8 向缩放。
    background.setEnabled(false)
    win.setBackgroundMaterial('none')
    win.setBackgroundColor('#f3f4f6')
    if (!skipPixels) {
      const opaque = await pixels('opaque')
      visible.push(opaque)
      if (opaque.edge.some((value, i) => Math.abs(value - [243, 244, 246][i % 3]) > 2))
        throw new Error('实色窗口边缘没有在一个原生像素内清晰显示')
    }
    if (nativeBackground.activeCount() !== 0) throw new Error('实色降级后没有释放原生背景')
    checkResize(await waitUntil(read, isResizeReady))
    if (nativeBackground.resizeCount() !== 1) throw new Error('实色降级错误地释放了窗口缩放检测')
    win.setBackgroundMaterial('acrylic')
    win.setBackgroundColor('#00000000')
    background.setEnabled(true)
    if (!skipPixels) visible.push(await pixels('reenabled'))
    if (nativeBackground.activeCount() !== 1)
      throw new Error('重新启用背景后没有恢复唯一的原生视觉')
    let invalidRejected = false
    try {
      nativeBackground.update(win.getNativeWindowHandle(), Number.NaN, 360)
    } catch (error) {
      if (!String(error).includes('窗口圆角或尺寸无效')) throw error
      invalidRejected = true
    }
    if (!invalidRejected) throw new Error('原生背景接受了无效圆角')
    if (nativeBackground.activeCount() !== 1) throw new Error('拒绝无效请求时破坏了已有原生背景')
    try {
      nativeBackground.updateResize(win.getNativeWindowHandle(), Number.NaN, 360, true)
      throw new Error('非法缩放参数未被拒绝')
    } catch (error) {
      if (!String(error).includes('窗口缩放参数无效')) throw error
    }
    if (nativeBackground.resizeCount() !== 1) throw new Error('非法参数破坏了已有缩放检测')
    win.destroy()
    background.dispose()
    if (nativeBackground.activeCount() !== 0) throw new Error('窗口销毁后没有释放原生视觉')
    if (nativeBackground.resizeCount() !== 0) throw new Error('窗口关闭后没有释放原生缩放检测')
    if (nativeBackground.resizeChildCount() !== 0)
      throw new Error('窗口关闭后没有释放 Chromium 命中订阅')
    const summary = {
      skipPixels,
      reports,
      maximized,
      restored,
      afterMinimize,
      fullScreen,
      afterFullScreen,
    }
    await writeFile(join(root, 'region.json'), JSON.stringify(summary))
    console.log('Windows 原生圆角验收：', JSON.stringify({ root, hwnd, ...summary, visible }))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    await inspector?.dispose()
    background?.dispose()
    if (win && !win.isDestroyed()) win.destroy()
    if (underlay && !underlay.isDestroyed()) underlay.destroy()
    app.exit(process.exitCode ?? 0)
  }
}
// Electron 必须先完成入口模块求值，才能触发 ready；入口不使用顶层 await。
void main()
