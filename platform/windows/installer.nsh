!macro customInit
  ; Active hosts must retain their exact runtime and UI during a manual upgrade.
  ; A crash marker is also treated conservatively: reopen the old app and stop its
  ; host explicitly; never terminate node.exe or remove application data here.
  IfFileExists "$LOCALAPPDATA\MongleTerminal\host-info.json" 0 +3
    MessageBox MB_OK|MB_ICONEXCLAMATION "Mongle Terminal host is active or was not shut down cleanly. Open the existing app, save your terminal work and choose Full exit (완전 종료…) before installing. Your sessions have not been stopped."
    Abort
  ; In-app updates pass --updated --force-run. Show the real NSIS file progress
  ; even when an older app version requested a silent install (/S). Ordinary
  ; silent installs without both flags stay silent. SetSilent is only valid in
  ; .onInit, where customInit is inserted.
  ${if} ${isUpdated}
  ${andIf} ${isForceRun}
  ${andIf} ${Silent}
    SetSilent normal
  ${endIf}
!macroend

!macro customInstallMode
  ; In-app updates (--updated --force-run) keep the existing installation
  ; scope without asking again. Other installs show the normal page.
  ${if} ${isUpdated}
  ${andIf} ${isForceRun}
    ${if} $hasPerUserInstallation == "1"
      StrCpy $isForceCurrentInstall "1"
    ${elseIf} $hasPerMachineInstallation == "1"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endIf}
  ${endIf}
!macroend

!macro customFinishPage
  ; Ordinary installs keep the standard finish page without a run option
  ; (runAfterFinish: false). Only an in-app update (--updated --force-run)
  ; that completed without abort restarts the app and skips the finish page.
  Function mongleUpdateFinishPre
    ${if} ${isUpdated}
    ${andIf} ${isForceRun}
      ${ifNot} ${Abort}
        ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
        ; StdUtils reports "ok" or "fallback" when the shell accepted the launch.
        ${if} $0 == "ok"
        ${orIf} $0 == "fallback"
          HideWindow
          Abort
        ${endIf}
        ; Keep the finish page so the window does not just vanish.
        MessageBox MB_OK|MB_ICONEXCLAMATION "Mongle Terminal was updated but could not be restarted automatically. Open Mongle Terminal (몽글터미널) from the Start menu or desktop shortcut."
      ${endIf}
    ${endIf}
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_PRE mongleUpdateFinishPre
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUnInit
  IfFileExists "$LOCALAPPDATA\MongleTerminal\host-info.json" 0 +3
    MessageBox MB_OK|MB_ICONEXCLAMATION "Open Mongle Terminal, save your work and choose Full exit (완전 종료…) before uninstalling. Closing the window keeps terminals running. Your sessions have not been stopped."
    Abort
!macroend

!macro customInstall
  ; Only an NSIS installation is eligible for in-app updates. This marker is
  ; deliberately absent from ZIP and unpacked builds, and contains no secrets.
  Push $0
  FileOpen $0 "$INSTDIR\resources\mongle-installed.json" w
  FileWrite $0 '{"installed":true}'
  FileClose $0
  Pop $0
!macroend
