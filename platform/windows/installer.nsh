!macro customInit
  ; Active hosts must retain their exact runtime and UI during a manual upgrade.
  ; A crash marker is also treated conservatively: reopen the old app and stop its
  ; host explicitly; never terminate node.exe or remove application data here.
  IfFileExists "$LOCALAPPDATA\MongleTerminal\host-info.json" 0 +3
    MessageBox MB_OK|MB_ICONEXCLAMATION "Mongle Terminal host is active or was not shut down cleanly. Open the existing app, save your terminal work and choose Full exit (완전 종료…) before installing. Your sessions have not been stopped."
    Abort
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
