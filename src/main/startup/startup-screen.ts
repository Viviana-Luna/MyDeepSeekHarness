import type { DesktopColorScheme } from '../../shared/appearance.ts'
import { DESKTOP_WINDOW_CORNER_RADIUS } from '../../shared/window.ts'

export interface StartupScreenSnapshot {
  phase: string
  label: string
}

const PHASE_LABELS: Record<string, string> = {
  starting: '正在加载插件',
  workspace: '正在准备工作空间',
  ready: '启动成功',
}

// 安装与检查属于启动阶段，子进程装配插件后才开始准备工作空间。
export function createStartupScreenSnapshot(phase: string): StartupScreenSnapshot {
  return { phase, label: PHASE_LABELS[phase] ?? '正在启动' }
}

export function createStartupScreenDocument(
  images: { light: string; dark: string },
  colorScheme: DesktopColorScheme,
  platform = 'darwin',
): string {
  const html = `<!doctype html>
<html lang="zh-CN" data-phase="initializing" data-color-scheme="${colorScheme}" data-platform="${platform === 'win32' ? 'win32' : 'darwin'}">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MyDSH 正在启动</title>
  ${platform === 'win32' ? '<link rel="stylesheet" href="window-controls.css"><script defer src="startup-window-controls.js"></script>' : ''}
  <style>
    :root {
      color-scheme: light;
      --surface: #f4f8ff;
      --ink: #14213b;
      --progress: #3f6fbd;
      --deck-bg: linear-gradient(180deg, rgb(255 255 255 / 84%), rgb(243 247 254 / 90%));
      --deck-border: rgb(255 255 255 / 96%);
      --deck-shadow: 0 14px 34px rgb(15 23 42 / 12%), inset 0 1px #fff, 0 0 0 0.5px rgb(15 23 42 / 8%);
      --track-bg: rgb(15 23 42 / 10%);
      --light-art: block;
      --dark-art: none;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", sans-serif;
    }
    :root[data-color-scheme="dark"] {
      color-scheme: dark;
      --surface: #0e192f;
      --ink: #f4f6ff;
      --progress: #93baff;
      --deck-bg: linear-gradient(180deg, rgb(18 23 34 / 72%), rgb(11 14 22 / 84%));
      --deck-border: rgb(255 255 255 / 18%);
      --deck-shadow: 0 16px 38px rgb(0 0 0 / 42%), inset 0 1px rgb(255 255 255 / 34%);
      --track-bg: rgb(5 7 12 / 55%);
      --light-art: none;
      --dark-art: block;
    }
    @media (prefers-color-scheme: dark) {
      :root[data-color-scheme="system"] {
        color-scheme: dark;
        --surface: #0e192f;
        --ink: #f4f6ff;
        --progress: #93baff;
        --deck-bg: linear-gradient(180deg, rgb(18 23 34 / 72%), rgb(11 14 22 / 84%));
        --deck-border: rgb(255 255 255 / 18%);
        --deck-shadow: 0 16px 38px rgb(0 0 0 / 42%), inset 0 1px rgb(255 255 255 / 34%);
        --track-bg: rgb(5 7 12 / 55%);
        --light-art: none;
        --dark-art: block;
      }
    }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { -webkit-app-region: drag; color: var(--ink); }
    :root[data-platform="win32"] body { clip-path: inset(0 var(--window-clip-right, 0px) var(--window-clip-bottom, 0px) 0 round var(--window-clip-radius, ${DESKTOP_WINDOW_CORNER_RADIUS}px)); }
    .launch-window {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
      border-radius: 12px;
      background: var(--surface);
      container-type: inline-size;
    }
    :root[data-platform="win32"] .launch-window { border-radius: 0; }
    .launch-window::after {
      content: "";
      position: absolute;
      inset: 0;
      border: 1px solid light-dark(rgb(49 67 101 / 12%), rgb(205 224 255 / 12%));
      border-radius: inherit;
      pointer-events: none;
    }
    .art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .art-light { display: var(--light-art); }
    .art-dark { display: var(--dark-art); }
    h1 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    .startup-feedback {
      position: absolute;
      left: 22px;
      right: 22px;
      bottom: 20px;
      display: grid;
      grid-template-rows: auto 7px;
      gap: 9px;
      padding: 13px 16px 12px;
      border: 1px solid var(--deck-border);
      border-radius: 16px;
      background: var(--deck-bg);
      box-shadow: var(--deck-shadow);
      backdrop-filter: blur(22px) saturate(1.55);
    }
    .startup-status {
      display: flex;
      align-items: center;
      gap: 9px;
      margin: 0;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.4;
      white-space: nowrap;
    }
    .startup-status::before {
      content: "";
      width: 9px;
      height: 9px;
      flex: none;
      border-radius: 50%;
      background: var(--progress);
      box-shadow: 0 0 12px var(--progress);
    }
    :root[data-phase="ready"] .startup-status::before { background: #36cc72; box-shadow: 0 0 12px #36cc72; }
    /* 启动阶段没有精确百分比，横条以持续流动表示仍在处理。 */
    .startup-progress {
      position: relative;
      height: 7px;
      overflow: hidden;
      border-radius: 999px;
      background: var(--track-bg);
      box-shadow: inset 0 1px 2px rgb(0 0 0 / 30%), 0 1px rgb(255 255 255 / 8%);
    }
    .startup-progress-fill {
      display: block;
      width: 30%;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #5e7cff, #859fff 60%, #7be0ff);
      box-shadow: inset 0 1px rgb(255 255 255 / 55%);
      animation: startup-sweep 1.8s cubic-bezier(.45, 0, .55, 1) infinite;
    }
    .startup-progress[hidden] { display: none; }
    .startup-progress[hidden] .startup-progress-fill { animation: none; }
    @keyframes startup-sweep {
      from { transform: translateX(-100%); }
      to { transform: translateX(350%); }
    }
    @media (prefers-reduced-motion: reduce) {
      .startup-progress-fill { animation: none; }
    }
    @media (prefers-reduced-transparency: reduce) {
      .startup-feedback { background: var(--surface); backdrop-filter: none; }
    }
    /* 强制色彩时隐藏插画，保留可读状态与横条；品牌仅供读屏识别。 */
    @media (forced-colors: active) {
      .launch-window { background: Canvas; color: CanvasText; }
      .art { display: none; }
      .launch-window::after { border-color: CanvasText; }
      .startup-feedback { border-color: CanvasText; background: Canvas; backdrop-filter: none; box-shadow: none; }
      .startup-status::before { background: CanvasText; box-shadow: none; }
      .startup-progress { background: GrayText; forced-color-adjust: none; }
      .startup-progress-fill { background: CanvasText; }
    }
  </style>
</head>
<body>
  <main class="launch-window" aria-labelledby="startup-title">
    <img class="art art-light" src="${images.light}" alt="" aria-hidden="true">
    <img class="art art-dark" src="${images.dark}" alt="" aria-hidden="true">
    <h1 id="startup-title">MyDSH</h1>
    <div class="startup-feedback">
      <p class="startup-status" id="startup-status" role="status" aria-live="polite" aria-atomic="true">正在启动</p>
      <div class="startup-progress" id="startup-progress" role="progressbar" aria-label="启动进度" aria-valuetext="正在启动">
        <span class="startup-progress-fill" aria-hidden="true"></span>
      </div>
    </div>
  </main>
  ${
    platform === 'win32'
      ? `<header class="windows-chrome" aria-label="窗口标题栏">
    <div class="window-controls" role="group" aria-label="窗口控制">
      <button type="button" data-window-action="minimize" aria-label="最小化窗口" title="最小化窗口"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6.5h10" /></svg></button>
      <button type="button" data-window-action="toggle-maximize" aria-label="最大化窗口" title="最大化窗口" disabled><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 1.5h9v9h-9z" /></svg></button>
      <button type="button" data-window-action="close" aria-label="关闭窗口" title="关闭窗口"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m1.5 1.5 9 9m0-9-9 9" /></svg></button>
    </div>
    <span class="window-control-error" id="window-control-error" role="alert"></span>
  </header>`
      : ''
  }
</body>
</html>`
  return html
}

export function createStartupScreenUpdateScript(snapshot: StartupScreenSnapshot): string {
  return `(() => {
    const next = ${JSON.stringify(snapshot)}
    const status = document.getElementById('startup-status')
    const progress = document.getElementById('startup-progress')
    if (status === null) throw new Error('启动画面缺少状态文字')
    if (progress === null) throw new Error('启动画面缺少进度横条')
    document.documentElement.dataset.phase = next.phase
    status.textContent = next.label
    progress.setAttribute('aria-valuetext', next.label)
    progress.hidden = next.phase === 'ready'
    return { phase: next.phase, label: status.textContent }
  })()`
}
