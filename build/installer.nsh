; Custom install-location page.
;
; electron-builder's built-in directory page (enabled via
; allowToChangeInstallationDirectory) uses NSIS's native Directory Page,
; which hard-disables the Install/Next button whenever the path is exactly
; a drive root (e.g. "F:\") — a long-standing NSIS engine restriction that
; can't be scripted around. We disable that built-in page
; (allowToChangeInstallationDirectory: false in package.json) and replace
; it with our own nsDialogs page here, which always keeps Install enabled
; and auto-appends the app folder name ("UKRAINE ONLINE") whenever the chosen
; folder doesn't already end with it — so a player can pick a bare drive
; letter and land in "F:\UKRAINE ONLINE" instead of getting stuck.
;
; This script is included in both the installer and uninstaller compile
; passes, but the page only makes sense for the installer — guard it the
; same way electron-builder's own template does, otherwise the uninstaller
; pass fails with "function not referenced" (warnings are treated as errors).
!ifndef BUILD_UNINSTALLER

!include "nsDialogs.nsh"
!include "StrContains.nsh"
!include "WinMessages.nsh"

Var InstallDirDialog
Var InstallDirText

!macro customPageAfterChangeDir
  Page custom InstallDirPageCreate InstallDirPageLeave
!macroend

; Windows' folder picker returns drive roots WITH a trailing backslash
; ("F:\") but regular folders WITHOUT one ("F:\Games") — append naively and
; a drive-root pick becomes "F:\\UKRAINE ONLINE". Strip any trailing backslash
; before appending the app folder name.
Function StripTrailingSlashAndAppendAppName
  ; in: $0 = path, out: $0 = sanitized path with "${APP_FILENAME}" ensured
  StrCpy $1 "$0" "" -1
  ${If} $1 == "\"
    StrCpy $0 "$0" -1
  ${EndIf}
  ${StrContains} $1 "${APP_FILENAME}" "$0"
  ${If} $1 == ""
    StrCpy $0 "$0\${APP_FILENAME}"
  ${EndIf}
FunctionEnd

Function InstallDirPageCreate
  nsDialogs::Create 1018
  Pop $InstallDirDialog
  ${If} $InstallDirDialog == error
    Abort
  ${EndIf}

  ; The header banner keeps whatever text the previous wizard page set
  ; (MUI_HEADER_TEXT isn't available to us here — this file is spliced into
  ; the script before any MUI_PAGE_* macro defines it), so set the header
  ; controls directly instead.
  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Тека встановлення"
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Оберіть теку, у яку буде встановлено ${PRODUCT_NAME}."

  ${NSD_CreateLabel} 0 0 100% 24u "Setup встановить ${PRODUCT_NAME} у наступну теку. Щоб обрати іншу — натисніть «Огляд...»."
  Pop $0

  ${NSD_CreateText} 0 30u 74% 14u "$INSTDIR"
  Pop $InstallDirText

  ${NSD_CreateButton} 77% 29u 23% 16u "Огляд..."
  Pop $0
  ${NSD_OnClick} $0 InstallDirBrowse

  nsDialogs::Show
FunctionEnd

Function InstallDirBrowse
  ${NSD_GetText} $InstallDirText $0
  nsDialogs::SelectFolderDialog "Оберіть теку встановлення" "$0"
  Pop $0
  ${If} $0 != error
    Call StripTrailingSlashAndAppendAppName
    ${NSD_SetText} $InstallDirText "$0"
  ${EndIf}
FunctionEnd

Function InstallDirPageLeave
  ${NSD_GetText} $InstallDirText $0
  ${If} $0 == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "Вкажіть теку встановлення."
    Abort
  ${EndIf}
  Call StripTrailingSlashAndAppendAppName
  StrCpy $INSTDIR "$0"
FunctionEnd

!endif
