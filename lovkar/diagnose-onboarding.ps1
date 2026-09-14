# lovkar/diagnose-onboarding.ps1 — run this WHILE the app is showing the onboarding screen.
#
# StarNet falls back to onboarding for several different reasons and they look identical from
# the outside. Twice now the cause was found only after the fact, from indirect traces. This
# captures the state at the moment it happens, which is the only time the evidence exists.
#
#   powershell -ExecutionPolicy Bypass -File D:\Claude\starnet-lovkar\lovkar\diagnose-onboarding.ps1
#
# Writes lovkar\_onboarding-report.txt. Nothing is changed; it only reads.

$ErrorActionPreference = 'SilentlyContinue'
$out = 'D:\Claude\starnet-lovkar\lovkar\_onboarding-report.txt'
$ws  = "$env:APPDATA\ai.skynet.harness\workspaces"

function W($s) { $s | Out-File $out -Append -Encoding utf8 }
"=== onboarding report $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File $out -Encoding utf8

W ""
W "-- processes --"
Get-Process skynet-desktop | Select-Object Id, StartTime | Format-Table -Auto | Out-String | ForEach-Object { W $_ }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CreationDate, CommandLine | Format-List | Out-String | ForEach-Object { W $_ }

W "-- workspace roots that exist --"
foreach ($d in @("$env:APPDATA\ai.skynet.harness\workspaces", "$env:LOCALAPPDATA\StarNet\workspaces", "$env:LOCALAPPDATA\Skynet\workspaces")) {
  if (Test-Path $d) { W ("  {0}  ({1} files)" -f $d, (Get-ChildItem $d -File | Measure-Object).Count) }
  else { W "  $d  (absent)" }
}
Get-ChildItem "$env:LOCALAPPDATA" -Filter "StarNet*" -Directory | ForEach-Object { W "  also present: $($_.FullName)" }

W ""
W "-- the workspace owner lock (the thing that blocks a healthy start) --"
$lock = Join-Path $ws '.starnet-workspace-owner.json'
if (Test-Path $lock) {
  $j = Get-Content $lock -Raw | ConvertFrom-Json
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($j.pid)"
  W ("  pid {0} | stamped {1}" -f $j.pid, (Get-Date -Date ([DateTimeOffset]::FromUnixTimeMilliseconds($j.startedAt).LocalDateTime) -Format 'HH:mm:ss'))
  W ("  exe recorded: " + $j.executable)
  if (-not $p) {
    W "  that pid is DEAD -> the lock is reclaimable, so it is NOT the cause"
  } else {
    # A live holder is normal when it IS this app's own sidecar. It is only a fault when some
    # OTHER process holds it, because then the app's sidecar is locked out of its own workspace.
    $mine = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'release\\sidecar' } | Select-Object -Expand ProcessId
    if ($mine -contains $j.pid) { W "  held by THIS app's own sidecar (pid $($j.pid)) -> normal, not the cause" }
    else { W "  held by a DIFFERENT live process ($($p.Name), pid $($j.pid))  <-- THIS IS THE FAULT: the app's sidecar cannot take its own workspace" }
  }
} else { W "  no lock file (not the cause)" }

W ""
W "-- what the save store holds (is anything lost?) --"
$js = @'
const fs=require('fs'),path=require('path');
const REL='D:/Claude/starnet-lovkar/src-tauri/target/release/sidecar';
const root=process.env.APPDATA+'\\ai.skynet.harness\\workspaces';
try{
  const d=require(REL+'/savestore.js').makeSaveStore({fs,pathMod:path,root,clock:{now:()=>Date.now()}}).load('agent');
  console.log(d ? ('  save OK: '+d.agent.name+' | rev '+d._saveRevision+' | '+new Date(d.updatedAt).toISOString()) : '  NO SAVE in the store');
}catch(e){ console.log('  save store threw: '+e.message); }
'@
$js | Out-File "$env:TEMP\_sv.js" -Encoding ascii
node "$env:TEMP\_sv.js" 2>&1 | ForEach-Object { W $_ }
Remove-Item "$env:TEMP\_sv.js"

W ""
W "-- sidecar port + whether it answers --"
$sc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'sidecar' } | Select-Object -First 1
if ($sc) {
  $ports = Get-NetTCPConnection -State Listen -OwningProcess $sc.ProcessId | Select-Object -Expand LocalPort -Unique
  W ("  sidecar pid {0} listening on: {1}" -f $sc.ProcessId, ($ports -join ', '))
  foreach ($p in $ports) {
    try { $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$p/api/lovkar/status" -TimeoutSec 5; W "  port $p -> $($r.StatusCode)" }
    catch { W ("  port {0} -> {1}   (403 is normal: it means the route is alive but needs the token)" -f $p, $_.Exception.Message) }
  }
} else { W "  NO sidecar process is running  <-- that alone explains the onboarding screen" }

Write-Host ""
Write-Host "written: $out"
Write-Host "Send me that file."
