!include "StrFunc.nsh"
${Using:StrFunc} StrRep

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Amiya Atlas" "InstallLocation"
  ${If} $R8 != ""
    ${StrRep} $R8 $R8 '"' ""
    IfFileExists "$R8\uninstall.exe" 0 relakeep_legacy_missing
    !insertmacro CheckIfAppIsRunning "$R8\amiya-atlas.exe" "Amiya Atlas"
    ; Keep the old directory and application data. Silent uninstallation never selects DeleteAppData.
    StrCpy $INSTDIR $R8
    ExecWait '"$R8\uninstall.exe" /S _?=$R8' $R9
    ${If} $R9 != 0
      MessageBox MB_ICONSTOP "旧版卸载失败，请关闭 Amiya Atlas 后重试。 / Could not uninstall the previous version."
      Abort
    ${EndIf}
    ReadRegStr $R9 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Amiya Atlas" "UninstallString"
    ${If} $R9 != ""
      MessageBox MB_ICONSTOP "旧版仍已注册，安装已停止以保留数据。 / The previous installation is still registered."
      Abort
    ${EndIf}
    Goto relakeep_legacy_done
    relakeep_legacy_missing:
      MessageBox MB_ICONSTOP "旧版卸载程序缺失，请修复旧版安装后再升级。 / Repair the previous installation before upgrading."
      Abort
  ${EndIf}
  relakeep_legacy_done:
  ; Tauri sets the extraction directory before this hook; follow the migrated install path.
  SetOutPath $INSTDIR
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${StrRep} $1 $INSTDIR "\" "/"
  FileOpen $0 "$INSTDIR\native-host\org.sayori.atlas.json" w
  FileWrite $0 '{"name":"org.sayori.atlas","description":"Relakeep browser capture bridge","path":"$1/amiya_atlas_native_host.exe","type":"stdio","allowed_origins":["chrome-extension://ikegkdiefpdlgbbhajphefckcjicacdc/"]}'
  FileClose $0
  WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\org.sayori.atlas" "" "$INSTDIR\native-host\org.sayori.atlas.json"
  WriteRegStr HKCU "Software\Microsoft\Edge\NativeMessagingHosts\org.sayori.atlas" "" "$INSTDIR\native-host\org.sayori.atlas.json"
!macroend
!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\org.sayori.atlas"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\org.sayori.atlas"
!macroend
