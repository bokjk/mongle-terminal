!macro customInit
  ; Active hosts must retain their exact runtime and UI during a manual upgrade.
  ; A crash marker is also treated conservatively: reopen the old app and stop its
  ; host explicitly; never terminate node.exe or remove application data here.
  IfFileExists "$LOCALAPPDATA\MongleTerminal\host-info.json" 0 +3
    MessageBox MB_OK|MB_ICONEXCLAMATION "Mongle Terminal host is active or was not shut down cleanly. Open the existing app, finish your terminal tasks and choose Stop host in settings before installing. Your sessions have not been stopped."
    Abort
!macroend

!macro customUnInit
  IfFileExists "$LOCALAPPDATA\MongleTerminal\host-info.json" 0 +3
    MessageBox MB_OK|MB_ICONEXCLAMATION "Mongle Terminal host must be stopped from the app before uninstalling. Closing the window keeps terminals running. Your sessions have not been stopped."
    Abort
!macroend
