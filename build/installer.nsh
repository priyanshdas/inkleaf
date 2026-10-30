; SPDX-License-Identifier: GPL-3.0-or-later
; Extra steps for the Windows installer (electron-builder picks this file up
; by itself). They register Inkleaf as a PDF app the way Windows expects, so
; it's listed by name under Settings > Apps > Default apps, and "Make Inkleaf
; the default PDF app" can open Settings straight on Inkleaf's page.
; Nothing here changes which app opens PDFs: only the person can choose that.

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\Inkleaf.pdf" "" "PDF Document"
  WriteRegStr SHCTX "Software\Classes\Inkleaf.pdf\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\Inkleaf.pdf\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHCTX "Software\Classes\.pdf\OpenWithProgids" "Inkleaf.pdf" ""

  WriteRegStr SHCTX "Software\Inkleaf\Capabilities" "ApplicationName" "Inkleaf"
  WriteRegStr SHCTX "Software\Inkleaf\Capabilities" "ApplicationDescription" "Free, open-source PDF editor"
  WriteRegStr SHCTX "Software\Inkleaf\Capabilities\FileAssociations" ".pdf" "Inkleaf.pdf"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Inkleaf" "Software\Inkleaf\Capabilities"

  ; tell Explorer the list of apps for file types has changed
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  ; an update runs the old uninstaller first; keep the registration then,
  ; or a PDF default someone chose would point at nothing for a moment
  ${ifNot} ${isUpdated}
    DeleteRegValue SHCTX "Software\RegisteredApplications" "Inkleaf"
    DeleteRegKey SHCTX "Software\Inkleaf\Capabilities"
    DeleteRegKey /ifempty SHCTX "Software\Inkleaf"
    DeleteRegValue SHCTX "Software\Classes\.pdf\OpenWithProgids" "Inkleaf.pdf"
    DeleteRegKey SHCTX "Software\Classes\Inkleaf.pdf"
    ; the File Explorer preview Inkleaf borrows is set for each user (src/main/default-app.ts)
    DeleteRegKey HKCU "Software\Classes\Inkleaf.pdf\ShellEx"
    DeleteRegKey /ifempty HKCU "Software\Classes\Inkleaf.pdf"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${endIf}
!macroend
