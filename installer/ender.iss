; The Windows installer: ender.exe for this user alone, on their PATH, with a Start menu icon that opens ender web.
; iscc /DVersion=<version> /DSource=<folder with ender-windows-x64.exe> installer\ender.iss
#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef Source
  #define Source "..\dist"
#endif

[Setup]
AppId={{400B101E-2285-4431-87C6-A1195A863C3C}
AppName=Ender
AppVersion={#Version}
AppPublisher=fatlard1993
AppPublisherURL=https://github.com/fatlard1993/ender-launcher
DefaultDirName={localappdata}\ender\bin
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ChangesEnvironment=yes
OutputDir={#Source}
OutputBaseFilename=Ender-Setup
SetupIconFile=..\assets\ender.ico
UninstallDisplayIcon={app}\ender.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "{#Source}\ender-windows-x64.exe"; DestDir: "{app}"; DestName: "ender.exe"; Flags: ignoreversion
Source: "..\assets\ender.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\Ender"; Filename: "{app}\ender.exe"; Parameters: "web --until-idle"; IconFilename: "{app}\ender.ico"; Flags: runminimized
Name: "{userdesktop}\Ender"; Filename: "{app}\ender.exe"; Parameters: "web --until-idle"; IconFilename: "{app}\ender.ico"; Flags: runminimized; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Put an Ender icon on the desktop"

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Check: NotOnPath(ExpandConstant('{app}'))

[Run]
Filename: "{app}\ender.exe"; Parameters: "web --until-idle"; Description: "Open Ender"; Flags: nowait postinstall runminimized

[Code]
function NotOnPath(Dir: string): Boolean;
var
  Path: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Path) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Path) + ';') = 0;
end;

procedure CurUninstallStepChanged(Step: TUninstallStep);
var
  Path, Dir: string;
  At: Integer;
begin
  if Step <> usPostUninstall then exit;
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Path) then exit;
  Dir := ExpandConstant('{app}');
  At := Pos(';' + Uppercase(Dir) + ';', Uppercase(Path) + ';');
  if At = 0 then exit;
  Delete(Path, At, Length(Dir) + 1);
  RegWriteExpandStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Path);
end;
