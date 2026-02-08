; Kill JSTorrent processes before install/uninstall to prevent
; "two instances running" when upgrading manually.

!macro _KillJSTorrentProcesses
  ; Kill main app
  nsis_tauri_utils::FindProcess "JSTorrent.exe" $R0
  ${If} $R0 = 0
    nsis_tauri_utils::KillProcess "JSTorrent.exe" $R0
  ${EndIf}

  ; Kill sidecar: system-bridge host
  nsis_tauri_utils::FindProcess "jstorrent-host.exe" $R0
  ${If} $R0 = 0
    nsis_tauri_utils::KillProcess "jstorrent-host.exe" $R0
  ${EndIf}

  ; Kill sidecar: io-daemon
  nsis_tauri_utils::FindProcess "jstorrent-io-daemon.exe" $R0
  ${If} $R0 = 0
    nsis_tauri_utils::KillProcess "jstorrent-io-daemon.exe" $R0
  ${EndIf}

  ; Give processes time to exit
  Sleep 1000
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro _KillJSTorrentProcesses
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _KillJSTorrentProcesses
!macroend
