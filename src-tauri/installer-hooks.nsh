!include "StrFunc.nsh"
${Using:StrFunc} StrRep

!macro NSIS_HOOK_POSTINSTALL
  ${StrRep} $1 $INSTDIR "\" "/"
  FileOpen $0 "$INSTDIR\native-host\org.sayori.atlas.json" w
  FileWrite $0 '{"name":"org.sayori.atlas","description":"Amiya Atlas browser capture bridge","path":"$1/amiya_atlas_native_host.exe","type":"stdio","allowed_origins":["chrome-extension://ikegkdiefpdlgbbhajphefckcjicacdc/"]}'
  FileClose $0
  WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\org.sayori.atlas" "" "$INSTDIR\native-host\org.sayori.atlas.json"
  WriteRegStr HKCU "Software\Microsoft\Edge\NativeMessagingHosts\org.sayori.atlas" "" "$INSTDIR\native-host\org.sayori.atlas.json"
!macroend
!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\org.sayori.atlas"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\org.sayori.atlas"
!macroend
