/**
 * 本地 renderer 的最小桌面桥。
 * 不暴露 Node、任意 IPC、URL、Cookie、文件路径或 shell；主进程仍会复核 sender 与参数。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron')

const CHANNELS = Object.freeze({
  windowRead: 'dsh-desktop:window:read',
  windowAct: 'dsh-desktop:window:act',
  windowChanged: 'dsh-desktop:window:changed',
  settingsRead: 'dsh-desktop:settings:read',
  settingsUpdate: 'dsh-desktop:settings:update',
  chooseBackground: 'dsh-desktop:settings:choose-background',
  applyBackground: 'dsh-desktop:settings:apply-background',
  cancelBackground: 'dsh-desktop:settings:cancel-background',
  clearBackground: 'dsh-desktop:settings:clear-background',
  chooseImages: 'dsh-desktop:attachments:choose-images',
  importImages: 'dsh-desktop:attachments:import-images',
  resolveDroppedFiles: 'dsh-desktop:file-references:resolve-dropped-files',
  settingsChanged: 'dsh-desktop:settings:changed',
  settingsOpenRequested: 'dsh-desktop:settings:open-requested',
  hostStatus: 'dsh-desktop:host:status',
  hostCall: 'dsh-desktop:host:call',
  hostSearchSessions: 'dsh-desktop:host:search-sessions',
  hostCancelSessionSearch: 'dsh-desktop:host:cancel-session-search',
  hostStatusChanged: 'dsh-desktop:host:status-changed',
  hostSessionFrame: 'dsh-desktop:host:session-frame',
  hostFrame: 'dsh-desktop:host:host-frame',
  sessionExportSave: 'dsh-desktop:session-exports:save',
  interactionRespond: 'dsh-desktop:interactions:respond',
  commandList: 'dsh-desktop:commands:list',
  skillList: 'dsh-desktop:commands:list-skills',
  commandExecute: 'dsh-desktop:commands:execute',
  projectList: 'dsh-desktop:project:list',
  projectCall: 'dsh-desktop:project:call',
  projectEvent: 'dsh-desktop:project:event',
  terminalCreate: 'dsh-desktop:terminal:create',
  terminalReady: 'dsh-desktop:terminal:ready',
  terminalWrite: 'dsh-desktop:terminal:write',
  terminalResize: 'dsh-desktop:terminal:resize',
  terminalClose: 'dsh-desktop:terminal:close',
  terminalClipboard: 'dsh-desktop:terminal:clipboard',
  terminalEvent: 'dsh-desktop:terminal:event',
  documentEdited: 'dsh-desktop:lifecycle:document-edited',
  closeRequested: 'dsh-desktop:lifecycle:close-requested',
  closeDecision: 'dsh-desktop:lifecycle:close-decision',
  projectTaskList: 'dsh-desktop:project-tasks:list',
  projectTaskSave: 'dsh-desktop:project-tasks:save',
  projectTaskRemove: 'dsh-desktop:project-tasks:remove',
  projectTaskReorder: 'dsh-desktop:project-tasks:reorder',
  projectTaskEvent: 'dsh-desktop:project-tasks:event',
  fileWorkspaceRead: 'dsh-desktop:file-state:read',
  fileWorkspaceSave: 'dsh-desktop:file-state:save',
  automationReadSettings: 'dsh-desktop:automation:read-settings',
  automationUpdateSettings: 'dsh-desktop:automation:update-settings',
  automationStatus: 'dsh-desktop:automation:status',
  automationStopTakeover: 'dsh-desktop:automation:stop-takeover',
  automationCheckPermissions: 'dsh-desktop:automation:check-permissions',
  automationOpenPermissionSettings: 'dsh-desktop:automation:open-permission-settings',
  automationDetectBrowsers: 'dsh-desktop:automation:detect-browsers',
  automationTestExternalBrowser: 'dsh-desktop:automation:test-external-browser',
  automationStateChanged: 'dsh-desktop:automation:state-changed',
  automationSettingsChanged: 'dsh-desktop:automation:settings-changed',
})

function listen(channel, listener, label) {
  if (typeof listener !== 'function') throw new TypeError(`${label}监听器必须是函数`)
  const wrapped = (_event, value) => {
    listener(value)
  }
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

let remoteSequence = 0

contextBridge.exposeInMainWorld(
  'dshDesktop',
  Object.freeze({
    version: 23,
    onTabAction: listener => listen('mydsh:workspace:tab-action', listener, '工作标签操作'),
    browser: Object.freeze({
      version: 1,
      request: request => ipcRenderer.invoke('mydsh:browser:request', request),
      onChanged: listener => listen('mydsh:browser:changed', listener, '浏览器状态'),
    }),
    window: Object.freeze({
      read: () => ipcRenderer.invoke(CHANNELS.windowRead),
      act: action => ipcRenderer.invoke(CHANNELS.windowAct, action),
      onChanged: listener => listen(CHANNELS.windowChanged, listener, '窗口状态'),
    }),
    remote: Object.freeze({
      call: (endpoint, args, id) => ipcRenderer.invoke('mydsh:remote:call', endpoint, args, id),
      cancelCall: id => ipcRenderer.invoke('mydsh:remote:cancel-call', id),
      follow: (endpoint, args, onItem, onError) => {
        if (typeof onItem !== 'function' || typeof onError !== 'function')
          throw new TypeError('Remote 事件需要数据和错误回调')
        const id = String(++remoteSequence)
        let stopped = false
        const stop = () => {
          if (stopped) return
          stopped = true
          unlisten()
          void ipcRenderer.invoke('mydsh:remote:cancel', id).catch(() => {})
        }
        const unlisten = listen(
          'mydsh:remote:frame',
          frame => {
            if (frame.id !== id || stopped) return
            if (frame.type === 'item') onItem(frame.value)
            else {
              stop()
              if (frame.type === 'error') onError(frame.message)
            }
          },
          '插件 Remote',
        )
        void ipcRenderer.invoke('mydsh:remote:follow', id, endpoint, args).catch(error => {
          if (!stopped) {
            stop()
            onError(error.message)
          }
        })
        return stop
      },
    }),
    setPluginBusyReasons: reasons => ipcRenderer.invoke('mydsh:plugins:busy', reasons),
    getFrontendPlugins: () => ipcRenderer.invoke('mydsh:plugins:frontend'),
    onFrontendPluginsChanged: listener => listen('mydsh:plugins:changed', listener, '插件资源'),
    settings: Object.freeze({
      read: () => ipcRenderer.invoke(CHANNELS.settingsRead),
      update: patch => ipcRenderer.invoke(CHANNELS.settingsUpdate, patch),
      chooseBackground: request => ipcRenderer.invoke(CHANNELS.chooseBackground, request),
      applyBackground: request => ipcRenderer.invoke(CHANNELS.applyBackground, request),
      cancelBackground: selectionId => ipcRenderer.invoke(CHANNELS.cancelBackground, selectionId),
      clearBackground: layer => ipcRenderer.invoke(CHANNELS.clearBackground, layer),
      onChanged: listener => listen(CHANNELS.settingsChanged, listener, '设置'),
      onOpenRequested: listener => listen(CHANNELS.settingsOpenRequested, listener, '打开设置'),
    }),
    attachments: Object.freeze({
      chooseImages: () => ipcRenderer.invoke(CHANNELS.chooseImages),
      importImages: images => ipcRenderer.invoke(CHANNELS.importImages, images),
      resolveDroppedFiles: (projectId, files) =>
        ipcRenderer.invoke(CHANNELS.resolveDroppedFiles, {
          projectId,
          absolutePaths: Array.from(files, file => webUtils.getPathForFile(file)),
        }),
    }),
    host: Object.freeze({
      status: () => ipcRenderer.invoke(CHANNELS.hostStatus),
      call: (operation, payload) => ipcRenderer.invoke(CHANNELS.hostCall, operation, payload),
      searchSessions: query => ipcRenderer.invoke(CHANNELS.hostSearchSessions, query),
      cancelSessionSearch: () => ipcRenderer.invoke(CHANNELS.hostCancelSessionSearch),
      onStatusChanged: listener => listen(CHANNELS.hostStatusChanged, listener, 'Host 状态'),
      onSessionFrame: listener => listen(CHANNELS.hostSessionFrame, listener, 'Session 实时帧'),
      onHostFrame: listener => listen(CHANNELS.hostFrame, listener, 'Host 实时帧'),
    }),
    sessionExports: Object.freeze({
      save: sessionId => ipcRenderer.invoke(CHANNELS.sessionExportSave, sessionId),
    }),
    interactions: Object.freeze({
      respond: submission => ipcRenderer.invoke(CHANNELS.interactionRespond, submission),
    }),
    commands: Object.freeze({
      list: sessionId => ipcRenderer.invoke(CHANNELS.commandList, sessionId),
      listSkills: sessionId => ipcRenderer.invoke(CHANNELS.skillList, sessionId),
      execute: request => ipcRenderer.invoke(CHANNELS.commandExecute, request),
    }),
    projects: Object.freeze({
      list: () => ipcRenderer.invoke(CHANNELS.projectList),
      call: (operation, payload) => ipcRenderer.invoke(CHANNELS.projectCall, operation, payload),
      onEvent: listener => listen(CHANNELS.projectEvent, listener, '项目事件'),
    }),
    terminal: Object.freeze({
      create: request => ipcRenderer.invoke(CHANNELS.terminalCreate, request),
      ready: terminalId => ipcRenderer.invoke(CHANNELS.terminalReady, terminalId),
      write: (terminalId, data) => ipcRenderer.invoke(CHANNELS.terminalWrite, terminalId, data),
      resize: (terminalId, columns, rows) =>
        ipcRenderer.invoke(CHANNELS.terminalResize, terminalId, columns, rows),
      close: terminalId => ipcRenderer.invoke(CHANNELS.terminalClose, terminalId),
      clipboard: action => ipcRenderer.invoke(CHANNELS.terminalClipboard, action),
      onEvent: listener => listen(CHANNELS.terminalEvent, listener, '终端'),
    }),
    lifecycle: Object.freeze({
      setDocumentEdited: edited => ipcRenderer.invoke(CHANNELS.documentEdited, edited),
      resolveClose: decision => ipcRenderer.invoke(CHANNELS.closeDecision, decision),
      onCloseRequested: listener => listen(CHANNELS.closeRequested, listener, '关闭窗口'),
    }),
    projectTasks: Object.freeze({
      list: projectId => ipcRenderer.invoke(CHANNELS.projectTaskList, projectId),
      save: request => ipcRenderer.invoke(CHANNELS.projectTaskSave, request),
      remove: taskId => ipcRenderer.invoke(CHANNELS.projectTaskRemove, taskId),
      reorder: (projectId, taskIds) =>
        ipcRenderer.invoke(CHANNELS.projectTaskReorder, projectId, taskIds),
      onEvent: listener => listen(CHANNELS.projectTaskEvent, listener, '项目任务'),
    }),
    fileWorkspace: Object.freeze({
      read: projectId => ipcRenderer.invoke(CHANNELS.fileWorkspaceRead, projectId),
      save: state => ipcRenderer.invoke(CHANNELS.fileWorkspaceSave, state),
    }),
    automation: Object.freeze({
      readSettings: () => ipcRenderer.invoke(CHANNELS.automationReadSettings),
      updateSettings: patch => ipcRenderer.invoke(CHANNELS.automationUpdateSettings, patch),
      status: () => ipcRenderer.invoke(CHANNELS.automationStatus),
      stopTakeover: () => ipcRenderer.invoke(CHANNELS.automationStopTakeover),
      checkPermissions: () => ipcRenderer.invoke(CHANNELS.automationCheckPermissions),
      openPermissionSettings: kind =>
        ipcRenderer.invoke(CHANNELS.automationOpenPermissionSettings, kind),
      detectBrowsers: () => ipcRenderer.invoke(CHANNELS.automationDetectBrowsers),
      testExternalBrowser: () => ipcRenderer.invoke(CHANNELS.automationTestExternalBrowser),
      onStateChanged: listener => listen(CHANNELS.automationStateChanged, listener, '自动化状态'),
      onSettingsChanged: listener =>
        listen(CHANNELS.automationSettingsChanged, listener, '自动化配置'),
    }),
  }),
)
