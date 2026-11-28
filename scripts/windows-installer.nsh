; MyDSH Windows 安装程序固定使用当前用户权限安装，不显示“所有用户 / 仅当前用户”选择页，
; 直接进入安装路径选择；卸载时同样固定按当前用户路径清理，不触发 UAC 提权。
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; 自定义 customCheckAppRunning 时，allowOnlyOneInstallerInstance.nsh 会跳过自带的
; getProcessInfo.nsh 与 $pid 声明，这里统一在页定义之后补齐，供安装器与卸载器共用。
!macro customHeader
  !include "getProcessInfo.nsh"
  Var pid
!macroend

; 覆盖安装时不仅检测目标目录，也在换路径迁移时检测并提示关闭上次安装目录中仍在运行的 MyDSH，
; 避免旧卸载器在静默模式下无提示直接结束窗口。
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING

  !ifndef BUILD_UNINSTALLER
    ${if} $PerUserInstallationFolder != ""
    ${andIf} $PerUserInstallationFolder != $INSTDIR
      Push $INSTDIR
      StrCpy $INSTDIR $PerUserInstallationFolder

      ${GetProcessInfo} 0 $pid $1 $2 $3 $4
      ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 == 0
          MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK oldDirStop
          Pop $INSTDIR
          Quit

          oldDirStop:
          DetailPrint "$(appClosing)"
          !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0
          Sleep 300

          StrCpy $R1 0
          oldDirLoop:
            IntOp $R1 $R1 + 1
            !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
            ${if} $R0 == 0
              Sleep 1000
              !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1
              !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
              ${if} $R0 == 0
                DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
                Sleep 2000
              ${else}
                Goto oldDirNotRunning
              ${endIf}
            ${else}
              Goto oldDirNotRunning
            ${endIf}

            ${if} $R1 > 1
              MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY oldDirLoop
              Pop $INSTDIR
              Quit
            ${else}
              Goto oldDirLoop
            ${endIf}
          oldDirNotRunning:
        ${endIf}
      ${endIf}

      Pop $INSTDIR
    ${endIf}
  !endif
!macroend

; 覆盖安装更新时清理旧目录：同盘符保留原子重命名与失败回滚；
; 跨盘符（如安装到 D:\ 而 %TEMP% 在 C:\）时 Windows Rename 无法跨卷移动，直接清理旧目录避免覆盖升级报“卸载失败：2”。
!macro customRemoveFiles
  ${if} ${isUpdated}
    StrCpy $R1 $INSTDIR 2
    StrCpy $R2 $PLUGINSDIR 2
    ${if} $R1 == $R2
      CreateDirectory "$PLUGINSDIR\old-install"

      Push ""
      Call un.atomicRMDir
      Pop $R0

      ${if} $R0 != 0
        DetailPrint "File is busy, aborting: $R0"

        Push ""
        Call un.restoreFiles
        Pop $R0

        Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
      ${endif}
    ${endif}
  ${endif}

  SetOutPath $TEMP
  RMDir /r "$INSTDIR"
!macroend
