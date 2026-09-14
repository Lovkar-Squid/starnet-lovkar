# lovkar/make-shortcut.ps1 - put a StarNet launcher on the Desktop.
# Points at the packaged build in src-tauri\target\release. Re-run after moving the repo.
$exe = 'D:\Claude\starnet-lovkar\src-tauri\target\release\skynet-desktop.exe'
if (-not (Test-Path $exe)) { Write-Error "not built yet: $exe"; exit 1 }

$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'StarNet.lnk'

$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = $exe
$s.WorkingDirectory = Split-Path $exe -Parent
$s.IconLocation = "$exe,0"
$s.Description = 'StarNet (Lovkar fork) - runs on the Claude subscription'
$s.Save()

Write-Output "shortcut: $lnk"
Write-Output "target  : $exe"
