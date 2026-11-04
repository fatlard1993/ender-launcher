# Install ender on Windows, or bring it up to date: one binary that needs nothing else installed.
#
#   irm https://raw.githubusercontent.com/fatlard1993/ender-launcher/main/install.ps1 | iex
#
# $env:ENDER_INSTALL names the folder it goes in (%LOCALAPPDATA%\ender\bin by default), $env:ENDER_VERSION a release.
# It adds an Ender icon to the Start menu unless $env:ENDER_DESKTOP is 0.
$ErrorActionPreference = 'Stop'

$repo = 'fatlard1993/ender-launcher'
$directory = if ($env:ENDER_INSTALL) { $env:ENDER_INSTALL } else { Join-Path $env:LOCALAPPDATA 'ender\bin' }
$base = if ($env:ENDER_VERSION) {
	"https://github.com/$repo/releases/download/v$($env:ENDER_VERSION.TrimStart('v'))"
} else {
	"https://github.com/$repo/releases/latest/download"
}

if (-not [Environment]::Is64BitOperatingSystem) { throw 'ender: there is a build for 64-bit Windows only' }

$binary = 'ender-windows-x64.exe'
$staging = Join-Path ([IO.Path]::GetTempPath()) "ender-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $staging | Out-Null

try {
	Write-Host "Downloading $binary"
	Invoke-WebRequest "$base/$binary" -OutFile (Join-Path $staging $binary) -UseBasicParsing
	Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $staging 'SHA256SUMS') -UseBasicParsing

	$expected = (Get-Content (Join-Path $staging 'SHA256SUMS') | Where-Object { $_ -match " $([regex]::Escape($binary))$" }) -split '\s+' | Select-Object -First 1
	$actual = (Get-FileHash (Join-Path $staging $binary) -Algorithm SHA256).Hash

	if (-not $expected -or $expected -ne $actual.ToLower()) { throw "ender: $binary is not the file the release lists; nothing was installed" }

	New-Item -ItemType Directory -Force -Path $directory | Out-Null
	Move-Item -Force (Join-Path $staging $binary) (Join-Path $directory 'ender.exe')
} finally {
	Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
}

$exe = Join-Path $directory 'ender.exe'
Write-Host "Installed $(& $exe --version) at $exe"

# ENDER_DESKTOP=0 leaves the Start menu as it was
if ($env:ENDER_DESKTOP -ne '0') {
	& $exe desktop
	if ($LASTEXITCODE -ne 0) { Write-Warning 'The Ender icon was not added; ender desktop tries again' }
}

$path = [Environment]::GetEnvironmentVariable('Path', 'User')

if (($path -split ';') -notcontains $directory) {
	[Environment]::SetEnvironmentVariable('Path', "$path;$directory", 'User')
	Write-Host 'Open Ender from the Start menu, or in a new terminal (this one does not see ender yet) start with: ender new survival, then ender launch'
} else {
	Write-Host 'Open Ender from the Start menu, or start with: ender new survival, then ender launch'
}
