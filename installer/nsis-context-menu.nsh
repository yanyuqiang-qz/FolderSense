; FolderSense NSIS 安装脚本扩展
; 在安装/卸载时写入/删除 Windows 资源管理器右键菜单

!include "FileAssociation.nsh"

; 安装时注册右键菜单
Section "Windows 资源管理器右键集成" SecShellContextMenu
  ; 文件右键 - "用 FolderSense 分析"
  WriteRegStr HKCU "Software\Classes\*\shell\FolderSense" "" "用 FolderSense 分析"
  WriteRegStr HKCU "Software\Classes\*\shell\FolderSense\command" "" '"$INSTDIR\FolderSense.exe" analyze "%1"'
  
  ; 文件夹右键 - "用 FolderSense 分析此文件夹"
  WriteRegStr HKCU "Software\Classes\Directory\shell\FolderSense" "" "用 FolderSense 分析此文件夹"
  WriteRegStr HKCU "Software\Classes\Directory\shell\FolderSense\command" "" '"$INSTDIR\FolderSense.exe" analyze "%1"'
  
  ; 文件夹背景右键（在文件夹空白处）
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\FolderSense" "" "用 FolderSense 打开 FolderSense"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\FolderSense\command" "" '"$INSTDIR\FolderSense.exe"'
SectionEnd

; 卸载时删除右键菜单
Section "un.SecShellContextMenu"
  DeleteRegKey HKCU "Software\Classes\*\shell\FolderSense"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\FolderSense"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\FolderSense"
SectionEnd
