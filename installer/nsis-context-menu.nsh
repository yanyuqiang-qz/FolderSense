; FolderSense NSIS 安装脚本扩展
; 通过 electron-builder 的 !macro install / !macro uninstall 机制注入
; 在安装时写入、卸载时删除 Windows 资源管理器右键菜单

!macro install
  ; 文件右键 - "用 FolderSense 分析"
  WriteRegStr HKCU "Software\Classes\*\shell\FolderSense" "" "用 FolderSense 分析"
  WriteRegStr HKCU "Software\Classes\*\shell\FolderSense\command" "" '"$INSTDIR\FolderSense.exe" analyze "%1"'

  ; 文件夹右键 - "用 FolderSense 分析此文件夹"
  WriteRegStr HKCU "Software\Classes\Directory\shell\FolderSense" "" "用 FolderSense 分析此文件夹"
  WriteRegStr HKCU "Software\Classes\Directory\shell\FolderSense\command" "" '"$INSTDIR\FolderSense.exe" analyze "%1"'

  ; 文件夹背景右键（在文件夹空白处）
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\FolderSense" "" "用 FolderSense 打开 FolderSense"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\FolderSense\command" "" '"$INSTDIR\FolderSense.exe"'
!macroend

!macro uninstall
  DeleteRegKey HKCU "Software\Classes\*\shell\FolderSense"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\FolderSense"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\FolderSense"
!macroend
