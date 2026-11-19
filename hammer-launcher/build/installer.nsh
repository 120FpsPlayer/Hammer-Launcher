; Hammer Launcher – additions to the NSIS installer made by electron-builder.

; Uninstalling: the entry „Uruchamiaj razem z Windows” goes too (src/main/main.js → applyLoginItem writes it under
; this name), and so do the hammer:// links the launcher registered for itself (main.js → registerProtocol) – a click
; on an invitation would otherwise end in a Windows error about a missing program. Not during an update –
; electron-builder runs the old uninstaller then as well, and the new version keeps both.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Hammer Launcher"
    DeleteRegKey HKCU "Software\Classes\hammer"
  ${endIf}
!macroend

; Installing: always for the current user only (%LOCALAPPDATA%\Programs), without the page „Dla kogo zainstalować?”.
; „Dla wszystkich użytkowników” puts the launcher in Program Files – every update would then need administrator
; rights: a UAC window out of nowhere when the launcher updates itself in the background, and on an account without
; administrator rights (a child's account) no update at all. The launcher's data is per user anyway (%APPDATA%).
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
