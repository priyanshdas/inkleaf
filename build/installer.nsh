; SPDX-License-Identifier: GPL-3.0-or-later
; Extra steps for the Windows installer (electron-builder picks this file up
; by itself). They register Inkleaf as a PDF app the way Windows expects, so
; it's listed by name under Settings > Apps > Default apps, and "Make Inkleaf
; the default PDF app" can open Settings straight on Inkleaf's page.
; Nothing here changes which app opens PDFs: only the person can choose that.

; --- Choices on the way in: shortcuts, and the built-in AI ------------------
;
; Two pages after the folder is chosen. The first asks for a desktop shortcut
; and a Start menu shortcut (both ticked to begin with). The second offers the
; built-in AI: a list of the models, the details of the one picked (what it's
; good for, download size, memory it needs), a tick to download it, and the
; total. Any number can be ticked, or none. Updates skip both pages and keep
; the shortcuts as they are.
;
; electron-builder makes both shortcuts as usual (so taskbar pinning and
; updates keep working); an unticked one is then taken away again.
;
; The models download straight into the folders the app itself uses
; (%APPDATA%\Inkleaf\ai), each checked against the same SHA-256 the app checks,
; so InkLeaf finds them ready. The list comes from the app's own
; (build/installer-ai.nsh, made by scripts/installer-ai.mjs). If a download
; fails, InkLeaf is still installed and the model can be downloaded later from
; Tools > AI Settings. "View details" on the installing page shows each step.

!ifndef BUILD_UNINSTALLER
  !include "nsDialogs.nsh"
  !include "${BUILD_RESOURCES_DIR}\installer-ai.nsh"

  Var inkleafDesktop
  Var inkleafStartMenu
  Var inkleafDesktopBox
  Var inkleafStartMenuBox
  Var inkleafAiList
  Var inkleafAiDetails
  Var inkleafAiBox
  Var inkleafAiTotal
  ; the model shown in the details, counting from 1
  Var inkleafAiShown

  ; whether each model is ticked: $inkleafAiWant1, $inkleafAiWant2…
  !macro inkleafAiVar N
    Var inkleafAiWant${N}
  !macroend
  !insertmacro inkleafEachModel inkleafAiVar

  ; The app keeps its models in the person's own AppData. $APPDATA isn't that
  ; for an install "for anyone who uses this computer" (it's ProgramData
  ; then), so the folder is asked for directly, for the person installing.
  Var inkleafAppData
  !define INKLEAF_AI_DIR "$inkleafAppData\Inkleaf\ai"

  ; takes the line break off the end of a line read from a file
  !macro inkleafTrimLine VAR
    StrCpy $9 ${VAR} 1 -1
    ${if} $9 == "$\n"
      StrCpy ${VAR} ${VAR} -1
    ${endif}
    StrCpy $9 ${VAR} 1 -1
    ${if} $9 == "$\r"
      StrCpy ${VAR} ${VAR} -1
    ${endif}
  !macroend

  ; Writes a model's or the engine's ".ok" mark: the app's sign it's been checked.
  !macro inkleafMarkOk file sha
    FileOpen $0 "${file}" w
    FileWrite $0 "${sha}"
    FileClose $0
  !macroend

  !macro inkleafGetModel N
    ${if} ${FileExists} "${INKLEAF_AI_DIR}\models\${AI_${N}_FILE}.ok"
      DetailPrint "The ${AI_${N}_NAME} AI model is already on this computer."
    ${else}
      Call inkleafGetEngine
      ${if} $R9 == "ok"
        CreateDirectory "${INKLEAF_AI_DIR}\models"
        StrCpy $R0 "${AI_${N}_URL}"
        StrCpy $R1 "${INKLEAF_AI_DIR}\models\${AI_${N}_FILE}"
        StrCpy $R2 "${AI_${N}_SHA256}"
        StrCpy $R3 "the ${AI_${N}_NAME} AI model (${AI_${N}_SIZE})"
        Call inkleafFetch
      ${endif}
      ${if} $R9 == "ok"
        !insertmacro inkleafMarkOk "${INKLEAF_AI_DIR}\models\${AI_${N}_FILE}.ok" "${AI_${N}_SHA256}"
        DetailPrint "The ${AI_${N}_NAME} AI model is ready."
      ${elseif} $R9 == "skipped"
        DetailPrint "Skipped the ${AI_${N}_NAME} AI model. InkLeaf can finish downloading it later, under Tools > AI Settings."
      ${else}
        DetailPrint "The ${AI_${N}_NAME} AI model couldn't be downloaded: $R9"
        MessageBox MB_OK|MB_ICONEXCLAMATION "The ${AI_${N}_NAME} AI model couldn't be downloaded ($R9).$\r$\n$\r$\nInkLeaf PDF is installed and works without it. You can download the model later in InkLeaf, under Tools > AI Settings." /SD IDOK
      ${endif}
    ${endif}
  !macroend

  ; --- the pieces of the AI page that differ for each model ---

  !macro inkleafAiInit N
    StrCpy $inkleafAiWant${N} ${BST_UNCHECKED}
  !macroend

  !macro inkleafAiAddToList N
    ${NSD_CB_AddString} $inkleafAiList "${AI_${N}_NAME}  (${AI_${N}_SIZE})"
  !macroend

  !macro inkleafAiShowCase N
    ${if} $inkleafAiShown == ${N}
      ${NSD_SetText} $inkleafAiDetails "${AI_${N}_BLURB}$\r$\n$\r$\nDownload: ${AI_${N}_SIZE}$\r$\nMemory: ${AI_${N}_MEMORY} or more is best$\r$\nModel: ${AI_${N}_MODEL}, from Hugging Face (Apache 2.0 licence)"
      ${if} ${FileExists} "${INKLEAF_AI_DIR}\models\${AI_${N}_FILE}.ok"
        ${NSD_SetText} $inkleafAiBox "Already downloaded on this computer"
        ${NSD_Uncheck} $inkleafAiBox
        EnableWindow $inkleafAiBox 0
      ${else}
        ${NSD_SetText} $inkleafAiBox "&Download this model during installation (${AI_${N}_SIZE})"
        EnableWindow $inkleafAiBox 1
        ${NSD_SetState} $inkleafAiBox $inkleafAiWant${N}
      ${endif}
    ${endif}
  !macroend

  !macro inkleafAiTickCase N
    ${if} $inkleafAiShown == ${N}
      StrCpy $inkleafAiWant${N} $0
    ${endif}
  !macroend

  ; adds a ticked model to the total: megabytes in $1, names in $2
  !macro inkleafAiSumCase N
    ${if} $inkleafAiWant${N} == ${BST_CHECKED}
      IntOp $1 $1 + ${AI_${N}_MB}
      ${if} $2 == ""
        StrCpy $2 "${AI_${N}_NAME}"
      ${else}
        StrCpy $2 "$2, ${AI_${N}_NAME}"
      ${endif}
    ${endif}
  !macroend

  ; $R8 notes that at least one model was asked for, for the log
  !macro inkleafAiGetCase N
    ${if} $inkleafAiWant${N} == ${BST_CHECKED}
      StrCpy $R8 "yes"
      !insertmacro inkleafGetModel ${N}
    ${endif}
  !macroend

  ; what's ticked to begin with (and what a silent install does)
  !macro customInit
    ; CSIDL_APPDATA: the roaming AppData of the person running this
    System::Call 'shell32::SHGetFolderPath(p 0, i 0x1A, p 0, i 0, t .r0)'
    StrCpy $inkleafAppData $0
    StrCpy $inkleafDesktop ${BST_CHECKED}
    StrCpy $inkleafStartMenu ${BST_CHECKED}
    !insertmacro inkleafEachModel inkleafAiInit
  !macroend

  ; Electron-builder includes this file before its own helpers (LogicLib, MUI),
  ; so the functions are defined here, where the installer's pages are.
  !macro customPageAfterChangeDir
    Page custom inkleafChoicesPage inkleafChoicesLeave
    Page custom inkleafAiPage

    ; the installing page gets a "View details" button that shows each step
    ShowInstDetails hide
    DetailsButtonText "View details"

    Function inkleafChoicesPage
      ${if} ${isUpdated}
        Abort
      ${endif}
      !insertmacro MUI_HEADER_TEXT "Shortcuts" "Where you'd like to find InkLeaf PDF."
      nsDialogs::Create 1018
      Pop $0
      ${NSD_CreateCheckbox} 0 4u 100% 12u "Create a &desktop shortcut"
      Pop $inkleafDesktopBox
      ${NSD_SetState} $inkleafDesktopBox $inkleafDesktop
      ${NSD_CreateCheckbox} 0 20u 100% 12u "Add InkLeaf PDF to the &Start menu"
      Pop $inkleafStartMenuBox
      ${NSD_SetState} $inkleafStartMenuBox $inkleafStartMenu
      ${NSD_CreateLabel} 0 44u 100% 20u "Next, you can choose built-in AI models to download, or skip them."
      Pop $0
      nsDialogs::Show
    FunctionEnd

    Function inkleafChoicesLeave
      ${NSD_GetState} $inkleafDesktopBox $inkleafDesktop
      ${NSD_GetState} $inkleafStartMenuBox $inkleafStartMenu
    FunctionEnd

    Function inkleafAiPage
      ${if} ${isUpdated}
        Abort
      ${endif}
      !insertmacro MUI_HEADER_TEXT "Built-in AI (optional)" "Choose AI models to download now, or skip this and add them later."
      nsDialogs::Create 1018
      Pop $0
      ${NSD_CreateLabel} 0 0 100% 18u "Summarise, translate and ask questions about PDFs with AI that runs on this computer: no account, and your files never leave it."
      Pop $0
      ${NSD_CreateLabel} 0 24u 30u 10u "&Model:"
      Pop $0
      ${NSD_CreateDropList} 32u 22u 160u 80u ""
      Pop $inkleafAiList
      !insertmacro inkleafEachModel inkleafAiAddToList
      ${NSD_OnChange} $inkleafAiList inkleafAiShow
      ${NSD_CreateGroupBox} 0 38u 100% 64u "Details"
      Pop $0
      ${NSD_CreateLabel} 8u 50u -16u 48u ""
      Pop $inkleafAiDetails
      ${NSD_CreateCheckbox} 0 106u 100% 12u ""
      Pop $inkleafAiBox
      ${NSD_OnClick} $inkleafAiBox inkleafAiTick
      ${NSD_CreateLabel} 0 122u 100% 18u ""
      Pop $inkleafAiTotal

      ; open on the model the app picks to begin with
      IntOp $0 ${AI_DEFAULT} - 1
      SendMessage $inkleafAiList ${CB_SETCURSEL} $0 0
      Call inkleafAiShow
      Call inkleafAiSum
      nsDialogs::Show
    FunctionEnd

    Function inkleafAiShow
      SendMessage $inkleafAiList ${CB_GETCURSEL} 0 0 $0
      IntOp $inkleafAiShown $0 + 1
      !insertmacro inkleafEachModel inkleafAiShowCase
    FunctionEnd

    Function inkleafAiTick
      ${NSD_GetState} $inkleafAiBox $0
      !insertmacro inkleafEachModel inkleafAiTickCase
      Call inkleafAiSum
    FunctionEnd

    ; "Will download: Quick, Better (4.0 GB in all)"
    Function inkleafAiSum
      StrCpy $1 0
      StrCpy $2 ""
      !insertmacro inkleafEachModel inkleafAiSumCase
      ${if} $1 == 0
        ${NSD_SetText} $inkleafAiTotal "Nothing will be downloaded. You can add AI models any time in InkLeaf, under Tools > AI Settings."
        Return
      ${endif}
      ${ifNot} ${FileExists} "${INKLEAF_AI_DIR}\${AI_ENGINE_DIR}\.ok"
        IntOp $1 $1 + ${AI_ENGINE_MB}
        StrCpy $2 "$2, and the AI engine"
      ${endif}
      ${if} $1 < 1000
        StrCpy $3 "$1 MB"
      ${else}
        IntOp $3 $1 / 1000
        IntOp $4 $1 % 1000
        IntOp $4 $4 / 100
        StrCpy $3 "$3.$4 GB"
      ${endif}
      ${NSD_SetText} $inkleafAiTotal "Will download: $2 ($3 in all). Make sure there's that much free space."
    FunctionEnd

    ; Downloads $R0 (link) to $R1 (file), checks it against $R2 (SHA-256),
    ; showing how far it's got in MB and GB. $R3 names it. Leaves "ok",
    ; "skipped" or what went wrong in $R9.
    ;
    ; The download itself is build/installer-fetch.ps1, run hidden; it writes
    ; its progress to a small file this reads a few times a second. A "Skip
    ; this download" tick next to View details stops it; what's downloaded so
    ; far is kept, and InkLeaf finishes it later from AI Settings.
    Function inkleafFetch
      DetailPrint "Downloading $R3 from $R0"
      InitPluginsDir
      File "/oname=$PLUGINSDIR\inkleaf-fetch.ps1" "${BUILD_RESOURCES_DIR}\installer-fetch.ps1"
      StrCpy $R5 "$PLUGINSDIR\inkleaf-status.txt"
      StrCpy $R6 "$PLUGINSDIR\inkleaf-stop"
      Delete $R5
      Delete $R6
      ; everything goes in through the environment, so no path can upset the command
      System::Call 'Kernel32::SetEnvironmentVariable(t "INKLEAF_URL", t "$R0")'
      System::Call 'Kernel32::SetEnvironmentVariable(t "INKLEAF_DEST", t "$R1")'
      System::Call 'Kernel32::SetEnvironmentVariable(t "INKLEAF_SHA256", t "$R2")'
      System::Call 'Kernel32::SetEnvironmentVariable(t "INKLEAF_STATUS", t "$R5")'
      System::Call 'Kernel32::SetEnvironmentVariable(t "INKLEAF_STOP", t "$R6")'

      ; the installing page: its status line, and a "Skip this download" tick
      ; beside the View details button
      FindWindow $R4 "#32770" "" $HWNDPARENT
      GetDlgItem $R8 $R4 1006
      GetDlgItem $0 $R4 1027
      System::Call '*(i, i, i, i) p.r1'
      System::Call 'user32::GetWindowRect(p r0, p r1)'
      System::Call 'user32::MapWindowPoints(p 0, p R4, p r1, i 2)'
      System::Call '*$1(i .r2, i .r3, i .r4, i .r5)'
      GetDlgItem $0 $R4 1004
      System::Call 'user32::GetWindowRect(p r0, p r1)'
      System::Call 'user32::MapWindowPoints(p 0, p R4, p r1, i 2)'
      System::Call '*$1(i, i, i .r6, i)'
      System::Free $1
      IntOp $2 $4 + 12
      IntOp $6 $6 - $2
      IntOp $5 $5 - $3
      ; WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX
      System::Call 'user32::CreateWindowEx(i 0, t "BUTTON", t "Skip this download (it can be finished later in InkLeaf)", i 0x50010003, i r2, i r3, i r6, i r5, p R4, p 0, p 0, p 0) p.R7'
      SendMessage $R4 ${WM_GETFONT} 0 0 $0
      SendMessage $R7 ${WM_SETFONT} $0 1

      ExecShell "" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\inkleaf-fetch.ps1"' SW_HIDE

      StrCpy $R9 ""
      StrCpy $7 0
      StrCpy $8 0
      ${do}
        Sleep 300
        IntOp $7 $7 + 1
        SendMessage $R7 ${BM_GETCHECK} 0 0 $0
        ${if} $0 == ${BST_CHECKED}
          ${ifNot} ${FileExists} $R6
            FileOpen $0 $R6 w
            FileClose $0
            SendMessage $R8 ${WM_SETTEXT} 0 "STR:Stopping the download of $R3..."
          ${endif}
          ; a stalled connection never gets to check for the stop file: move on anyway
          IntOp $8 $8 + 1
          ${if} $8 > 50
            StrCpy $R9 "skipped"
            ${break}
          ${endif}
        ${endif}
        ClearErrors
        FileOpen $0 $R5 r
        ${if} ${errors}
          ; nothing heard after a minute: PowerShell didn't start
          ${if} $7 > 200
            StrCpy $R9 "the download couldn't start"
            ${break}
          ${endif}
          ${continue}
        ${endif}
        FileReadUTF16LE $0 $1
        FileReadUTF16LE $0 $2
        FileClose $0
        !insertmacro inkleafTrimLine $1
        !insertmacro inkleafTrimLine $2
        ${if} $1 == "progress"
          SendMessage $R8 ${WM_SETTEXT} 0 "STR:Downloading $R3: $2"
        ${elseif} $1 == "ok"
          StrCpy $R9 "ok"
          ${break}
        ${elseif} $1 == "stopped"
          StrCpy $R9 "skipped"
          ${break}
        ${elseif} $1 == "error"
          StrCpy $R9 $2
          ${break}
        ${endif}
      ${loop}
      System::Call 'user32::DestroyWindow(p R7)'
      ${if} $R9 == "ok"
        DetailPrint "Checked against its SHA-256 ($R2) and saved to $R1"
      ${endif}
    FunctionEnd

    ; The AI engine (llama.cpp), unpacked where the app expects it. Leaves "ok" or the problem in $R9.
    Function inkleafGetEngine
      ${if} ${FileExists} "${INKLEAF_AI_DIR}\${AI_ENGINE_DIR}\.ok"
        StrCpy $R9 "ok"
        Return
      ${endif}
      CreateDirectory "${INKLEAF_AI_DIR}"
      StrCpy $R0 "${AI_ENGINE_URL}"
      StrCpy $R1 "${INKLEAF_AI_DIR}\${AI_ENGINE_FILE}"
      StrCpy $R2 "${AI_ENGINE_SHA256}"
      StrCpy $R3 "the AI engine (${AI_ENGINE_SIZE})"
      Call inkleafFetch
      ${if} $R9 != "ok"
        Return
      ${endif}
      RMDir /r "${INKLEAF_AI_DIR}\${AI_ENGINE_DIR}"
      CreateDirectory "${INKLEAF_AI_DIR}\${AI_ENGINE_DIR}"
      DetailPrint "Unpacking the AI engine..."
      ${DisableX64FSRedirection}
      nsExec::ExecToLog '"$SYSDIR\tar.exe" -xf "${INKLEAF_AI_DIR}\${AI_ENGINE_FILE}" -C "${INKLEAF_AI_DIR}\${AI_ENGINE_DIR}"'
      ${EnableX64FSRedirection}
      Pop $0
      Delete "${INKLEAF_AI_DIR}\${AI_ENGINE_FILE}"
      ${if} $0 != 0
        RMDir /r "${INKLEAF_AI_DIR}\${AI_ENGINE_DIR}"
        StrCpy $R9 "the AI engine couldn't be unpacked"
        Return
      ${endif}
      !insertmacro inkleafMarkOk "${INKLEAF_AI_DIR}\${AI_ENGINE_DIR}\.ok" "${AI_ENGINE_SHA256}"
      StrCpy $R9 "ok"
    FunctionEnd
  !macroend

  !macro inkleafApplyChoices
    ${ifNot} ${isUpdated}
      ${if} $inkleafDesktop == ${BST_CHECKED}
        DetailPrint "Added a desktop shortcut."
      ${else}
        WinShell::UninstShortcut "$newDesktopLink"
        Delete "$newDesktopLink"
        DetailPrint "No desktop shortcut, as chosen."
      ${endif}
      ${if} $inkleafStartMenu == ${BST_CHECKED}
        DetailPrint "Added InkLeaf PDF to the Start menu."
      ${else}
        WinShell::UninstShortcut "$newStartMenuLink"
        Delete "$newStartMenuLink"
        ; "Run InkLeaf PDF" at the end then starts the program itself
        StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        DetailPrint "Not added to the Start menu, as chosen."
      ${endif}
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${else}
      DetailPrint "Kept the shortcuts as they were."
    ${endif}
    StrCpy $R8 ""
    !insertmacro inkleafEachModel inkleafAiGetCase
    ${if} $R8 == ""
      DetailPrint "No built-in AI models chosen. They can be added any time in InkLeaf, under Tools > AI Settings."
    ${endif}
    DetailPrint "All done."
  !macroend
!endif

!macro customInstall
  ; electron-builder hides the log during installing (SetDetailsPrint none in
  ; its installSection.nsh), which left "View details" empty. Show it again
  ; from here on, with a line for each step.
  !ifndef BUILD_UNINSTALLER
    SetDetailsPrint both
    ${if} ${isUpdated}
      DetailPrint "Updated InkLeaf PDF ${VERSION} in $INSTDIR"
    ${else}
      DetailPrint "Installed InkLeaf PDF ${VERSION} in $INSTDIR"
    ${endif}
    DetailPrint "Registering InkLeaf PDF as an app that can open PDFs..."
  !endif
  WriteRegStr SHCTX "Software\Classes\Inkleaf.pdf" "" "PDF Document"
  WriteRegStr SHCTX "Software\Classes\Inkleaf.pdf\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\Inkleaf.pdf\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHCTX "Software\Classes\.pdf\OpenWithProgids" "Inkleaf.pdf" ""

  ; File Explorer's thumbnails of PDFs: a picture of the first page, drawn by
  ; Inkleaf's own thumbnail maker (native/thumbnails) once Inkleaf opens PDFs
  !ifndef BUILD_UNINSTALLER
    DetailPrint "Adding PDF thumbnails and the preview pane to File Explorer..."
  !endif
  WriteRegStr SHCTX "Software\Classes\CLSID\{1EBEB7F8-27A7-4B2A-A890-88C35591D436}" "" "InkLeaf PDF thumbnails"
  WriteRegStr SHCTX "Software\Classes\CLSID\{1EBEB7F8-27A7-4B2A-A890-88C35591D436}\InprocServer32" "" "$INSTDIR\resources\thumbnails\inkleaf-thumbs.dll"
  WriteRegStr SHCTX "Software\Classes\CLSID\{1EBEB7F8-27A7-4B2A-A890-88C35591D436}\InprocServer32" "ThreadingModel" "Apartment"
  WriteRegStr SHCTX "Software\Classes\Inkleaf.pdf\ShellEx\{e357fccd-a995-4576-b01f-234630154e96}" "" "{1EBEB7F8-27A7-4B2A-A890-88C35591D436}"
  ; electron-builder registers PDFs under its own name too ("PDF Document",
  ; from fileAssociations in package.json), and that's often the one chosen
  WriteRegStr SHCTX "Software\Classes\PDF Document\ShellEx\{e357fccd-a995-4576-b01f-234630154e96}" "" "{1EBEB7F8-27A7-4B2A-A890-88C35591D436}"

  ; File Explorer's preview pane: every page, from the same DLL. Explorer
  ; runs previewers in its own helper program (prevhost), named by the AppID
  WriteRegStr SHCTX "Software\Classes\CLSID\{426761B5-11FE-448D-8071-7EAC4FBFAED9}" "" "InkLeaf PDF preview"
  WriteRegStr SHCTX "Software\Classes\CLSID\{426761B5-11FE-448D-8071-7EAC4FBFAED9}" "DisplayName" "InkLeaf PDF preview"
  WriteRegStr SHCTX "Software\Classes\CLSID\{426761B5-11FE-448D-8071-7EAC4FBFAED9}" "AppID" "{6d2b5079-2f0b-48dd-ab7f-97cec514d30b}"
  WriteRegStr SHCTX "Software\Classes\CLSID\{426761B5-11FE-448D-8071-7EAC4FBFAED9}\InprocServer32" "" "$INSTDIR\resources\thumbnails\inkleaf-thumbs.dll"
  WriteRegStr SHCTX "Software\Classes\CLSID\{426761B5-11FE-448D-8071-7EAC4FBFAED9}\InprocServer32" "ThreadingModel" "Apartment"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\PreviewHandlers" "{426761B5-11FE-448D-8071-7EAC4FBFAED9}" "InkLeaf PDF preview"
  WriteRegStr SHCTX "Software\Classes\Inkleaf.pdf\ShellEx\{8895b1c6-b41f-4c1c-a562-0d564250836f}" "" "{426761B5-11FE-448D-8071-7EAC4FBFAED9}"
  WriteRegStr SHCTX "Software\Classes\PDF Document\ShellEx\{8895b1c6-b41f-4c1c-a562-0d564250836f}" "" "{426761B5-11FE-448D-8071-7EAC4FBFAED9}"

  WriteRegStr SHCTX "Software\Inkleaf\Capabilities" "ApplicationName" "InkLeaf PDF"
  WriteRegStr SHCTX "Software\Inkleaf\Capabilities" "ApplicationDescription" "Free, open-source PDF editor"
  WriteRegStr SHCTX "Software\Inkleaf\Capabilities\FileAssociations" ".pdf" "Inkleaf.pdf"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Inkleaf" "Software\Inkleaf\Capabilities"
  ; the name in "Open with" (the program file itself is still Inkleaf.exe)
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "InkLeaf PDF"

  ; tell Explorer the list of apps for file types has changed
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  !insertmacro inkleafApplyChoices
!macroend

!macro customUnInstall
  ; an update runs the old uninstaller first; keep the registration then,
  ; or a PDF default someone chose would point at nothing for a moment
  ${ifNot} ${isUpdated}
    DeleteRegValue SHCTX "Software\RegisteredApplications" "Inkleaf"
    DeleteRegValue SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName"
    DeleteRegKey SHCTX "Software\Inkleaf\Capabilities"
    DeleteRegKey /ifempty SHCTX "Software\Inkleaf"
    DeleteRegValue SHCTX "Software\Classes\.pdf\OpenWithProgids" "Inkleaf.pdf"
    DeleteRegKey SHCTX "Software\Classes\Inkleaf.pdf"
    DeleteRegKey SHCTX "Software\Classes\CLSID\{1EBEB7F8-27A7-4B2A-A890-88C35591D436}"
    DeleteRegKey SHCTX "Software\Classes\CLSID\{426761B5-11FE-448D-8071-7EAC4FBFAED9}"
    DeleteRegValue SHCTX "Software\Microsoft\Windows\CurrentVersion\PreviewHandlers" "{426761B5-11FE-448D-8071-7EAC4FBFAED9}"
    ; File Explorer's thumbnails and preview are also set for each user (src/main/default-app.ts)
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
