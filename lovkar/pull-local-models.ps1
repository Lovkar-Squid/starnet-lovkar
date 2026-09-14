# lovkar/pull-local-models.ps1 - fetch the local brains for the ollama provider.
# Runs detached and logs, because a pull is gigabytes and outlives any single shell.
$log = 'D:\Claude\starnet-lovkar\lovkar\_pull.log'
"=== started $(Get-Date -Format 'HH:mm:ss') ===" | Out-File $log -Encoding utf8

foreach ($m in @('qwen3:8b', 'qwen3:14b')) {
  "--- pulling $m at $(Get-Date -Format 'HH:mm:ss')" | Out-File $log -Append -Encoding utf8
  & ollama pull $m *>&1 | Out-File $log -Append -Encoding utf8
  "--- exit $LASTEXITCODE for $m" | Out-File $log -Append -Encoding utf8
}

"=== installed ===" | Out-File $log -Append -Encoding utf8
& ollama list *>&1 | Out-File $log -Append -Encoding utf8
"=== done $(Get-Date -Format 'HH:mm:ss') ===" | Out-File $log -Append -Encoding utf8
