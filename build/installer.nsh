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

  ; File Explorer's thumbnails of PDFs: a picture of the first page, drawn by
  ; Inkleaf's own thumbnail maker (native/thumbnails) once Inkleaf opens PDFs
  WriteRegStr SHCTX "Software\Classes\CLSID\{1EBEB7F8-27A7-4B2A-A890-88C35591D436}" "" "Inkleaf PDF thumbnails"
  WriteRegStr SHCTX "Software\Classes\CLSID\{1EBEB7F8-27A7-4B2A-A890-88C35591D436}\InprocServer32" "" "$INSTDIR\resources\thumbnails\inkleaf-thumbs.dll"
  WriteRegStr SHCTX "Software\Classes\CLSID\{1EBEB7F8-27A7-4B2A-A890-88C35591D436}\InprocServer32" "ThreadingModel" "Apartment"
  WriteRegStr SHCTX "Software\Classes\Inkleaf.pdf\ShellEx\{e357fccd-a995-4576-b01f-234630154e96}" "" "{1EBEB7F8-27A7-4B2A-A890-88C35591D436}"
  ; electron-builder registers PDFs under its own name too ("PDF Document",
  ; from fileAssociations in package.json), and that's often the one chosen
  WriteRegStr SHCTX "Software\Classes\PDF Document\ShellEx\{e357fccd-a995-4576-b01f-234630154e96}" "" "{1EBEB7F8-27A7-4B2A-A890-88C35591D436}"

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
    DeleteRegKey SHCTX "Software\Classes\CLSID\{1EBEB7F8-27A7-4B2A-A890-88C35591D436}"
    ; the File Explorer preview Inkleaf borrows is set for each user (src/main/default-app.ts)
    DeleteRegKey HKCU "Software\Classes\Inkleaf.pdf\ShellEx"
    DeleteRegKey SHCTX "Software\Classes\PDF Document\ShellEx"
    DeleteRegKey HKCU "Software\Classes\PDF Document\ShellEx"
    DeleteRegKey /ifempty HKCU "Software\Classes\Inkleaf.pdf"
    ; File Explorer's right-click menu, added for each user by Inkleaf itself (src/main/desktop.ts)
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.pdf\shell\Inkleaf.Combine"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.pdf\shell\Inkleaf.Print"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.pdf\shell\Inkleaf.Compress"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\image\shell\Inkleaf.MakePdf"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.docx\shell\Inkleaf.MakePdf"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.doc\shell\Inkleaf.MakePdf"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.odt\shell\Inkleaf.MakePdf"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.rtf\shell\Inkleaf.MakePdf"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.xlsx\shell\Inkleaf.MakePdf"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.xls\shell\Inkleaf.MakePdf"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.ods\shell\Inkleaf.MakePdf"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.csv\shell\Inkleaf.MakePdf"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.pptx\shell\Inkleaf.MakePdf"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.ppt\shell\Inkleaf.MakePdf"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.odp\shell\Inkleaf.MakePdf"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.txt\shell\Inkleaf.MakePdf"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.md\shell\Inkleaf.MakePdf"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.markdown\shell\Inkleaf.MakePdf"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.html\shell\Inkleaf.MakePdf"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.htm\shell\Inkleaf.MakePdf"
    ; starting at sign-in (Settings in Inkleaf)
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "io.github.priyanshdas.inkleaf"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Inkleaf"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${endIf}
!macroend
