#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\build\desktop\HDU-Library-Sniper"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\dist"
#endif

[Setup]
AppId={{BC223D8D-A6AB-40D3-A2B5-919D2552C23D}
AppName=HDU Library Sniper
AppVersion={#AppVersion}
AppPublisher=HDU Library Sniper Contributors
DefaultDirName={localappdata}\Programs\HDU Library Sniper
DefaultGroupName=HDU Library Sniper
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=HDU-Library-Sniper-Setup-{#AppVersion}
SetupIconFile=..\..\assets\app-icon.ico
UninstallDisplayIcon={app}\HDU-Library-Sniper.exe
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\HDU Library Sniper"; Filename: "{app}\HDU-Library-Sniper.exe"
Name: "{autodesktop}\HDU Library Sniper"; Filename: "{app}\HDU-Library-Sniper.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式："; Flags: unchecked

[Run]
Filename: "{app}\HDU-Library-Sniper.exe"; Description: "启动 HDU Library Sniper"; Flags: nowait postinstall skipifsilent
