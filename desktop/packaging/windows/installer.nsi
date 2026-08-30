Unicode True
!define PRODUCT_NAME "xiaoha grok 桌面版"
!define PRODUCT_VERSION "0.6.69"
!define PRODUCT_PUBLISHER "小哈AI"
!define PRODUCT_EXE "xiaoha-grok.exe"
!define PROTOCOL "grokdesk"

Name "${PRODUCT_NAME}"
OutFile "GrokDesk-${PRODUCT_VERSION}-windows-x64-setup.exe"
InstallDir "$LOCALAPPDATA\GrokDesk"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Icon "icon.ico"
UninstallIcon "icon.ico"

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  File /oname=${PRODUCT_EXE} "grokdesk.exe"
  File "icon.ico"
  Delete "$INSTDIR\GrokDesk.exe"
  Delete "$DESKTOP\GrokDesk.lnk"
  Delete "$SMPROGRAMS\GrokDesk\GrokDesk.lnk"
  RMDir "$SMPROGRAMS\GrokDesk"

  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\icon.ico"
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\icon.ico"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GrokDesk" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GrokDesk" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GrokDesk" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GrokDesk" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GrokDesk" "DisplayIcon" "$INSTDIR\${PRODUCT_EXE}"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GrokDesk" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GrokDesk" "NoRepair" 1

  WriteRegStr HKCU "Software\Classes\${PROTOCOL}" "" "URL:${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Classes\${PROTOCOL}" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\${PROTOCOL}\DefaultIcon" "" "$INSTDIR\${PRODUCT_EXE},0"
  WriteRegStr HKCU "Software\Classes\${PROTOCOL}\shell\open\command" "" '"$INSTDIR\${PRODUCT_EXE}" "%1"'
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\${PRODUCT_EXE}"
  Delete "$INSTDIR\icon.ico"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GrokDesk"
  DeleteRegKey HKCU "Software\Classes\${PROTOCOL}"
SectionEnd
