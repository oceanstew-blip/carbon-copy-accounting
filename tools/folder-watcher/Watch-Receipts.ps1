# Receipt folder watcher for Windows PowerShell 5.1 (built into Windows, nothing to install).
#
#   First time:   right-click > Run with PowerShell, or:  powershell -ExecutionPolicy Bypass -File Watch-Receipts.ps1 -Setup
#   It then runs in the background at every login and uploads what lands in the folder.
#
# Folder rules:
#   - A photo dropped loose in the folder is one receipt, unless it is numbered right after
#     another photo taken seconds earlier (IMG_2041, IMG_2042) - those are suggested as one long receipt.
#   - A SUBFOLDER is always exactly one receipt (put all photos of a long receipt in it).
#   - Uploaded files are moved to Done\. Anything that fails stays put and is retried.
param([switch]$Setup)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $Here 'config.json'
$LogPath = Join-Path $Here 'watcher.log'
$Exts = '.jpg','.jpeg','.png','.webp','.heic','.heif','.pdf'
$SettleSeconds = 45   # file must be this old (finished syncing/copying) before upload

function Log($m) { Add-Content -Path $LogPath -Value ("{0}  {1}" -f (Get-Date -Format 's'), $m) }

if ($Setup) {
  $url  = Read-Host 'App address (e.g. https://infinite-bliss.up.railway.app)'
  $user = Read-Host 'App username'
  $pass = Read-Host 'App password' -AsSecureString
  $folder = Read-Host 'Receipts folder (press Enter for Desktop\Receipts)'
  if (-not $folder) { $folder = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Receipts' }
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  @{ url = $url.TrimEnd('/'); user = $user; pass = ($pass | ConvertFrom-SecureString); folder = $folder } | ConvertTo-Json | Set-Content $ConfigPath
  $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $MyInvocation.MyCommand.Path)
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  Register-ScheduledTask -TaskName 'Receipt Folder Watcher' -Action $action -Trigger $trigger -Force | Out-Null
  Start-ScheduledTask -TaskName 'Receipt Folder Watcher'
  Write-Host "Done. Drop receipts into $folder. Log: $LogPath"
  return
}

$cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(($cfg.pass | ConvertTo-SecureString))
$password = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
$root = $cfg.folder
$doneRoot = Join-Path $root 'Done'
New-Item -ItemType Directory -Force -Path $doneRoot | Out-Null

$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromMinutes(10)
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($cfg.user):$password"))
$http.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Basic', $basic)

function Send-Files($files, $mode) {
  $form = New-Object System.Net.Http.MultipartFormDataContent
  $form.Add((New-Object System.Net.Http.StringContent($mode)), 'mode')
  $mtimes = @($files | ForEach-Object { [int64]([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeMilliseconds() })
  $form.Add((New-Object System.Net.Http.StringContent((ConvertTo-Json -InputObject $mtimes -Compress))), 'mtimes')
  foreach ($f in $files) {
    $part = New-Object System.Net.Http.ByteArrayContent(, [IO.File]::ReadAllBytes($f.FullName))
    $form.Add($part, 'files', $f.Name)
  }
  $resp = $http.PostAsync("$($cfg.url)/api/receipts/inbox", $form).Result
  $body = $resp.Content.ReadAsStringAsync().Result
  if (-not $resp.IsSuccessStatusCode) { throw "Server said $([int]$resp.StatusCode): $body" }
  return ($body | ConvertFrom-Json)
}

function Move-ToDone($file, $sub) {
  $dest = if ($sub) { Join-Path $doneRoot $sub } else { $doneRoot }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $target = Join-Path $dest $file.Name
  if (Test-Path $target) { $target = Join-Path $dest ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $file.Name) }
  Move-Item -LiteralPath $file.FullName -Destination $target
}

function Is-Ready($f) { ((Get-Date) - $f.LastWriteTime).TotalSeconds -ge $SettleSeconds }

function Process-Batch($files, $mode, $sub) {
  if (-not $files -or $files.Count -eq 0) { return }
  try {
    $res = Send-Files $files $mode
    foreach ($g in $res.groups) {
      if ($g.status -eq 'ingested' -or $g.status -eq 'duplicate') {
        foreach ($n in $g.files) { $f = $files | Where-Object { $_.Name -eq $n } | Select-Object -First 1; if ($f) { Move-ToDone $f $sub } }
        Log ("{0}: {1} ({2})" -f $g.status, ($g.files -join ', '), $g.id)
      } else {
        Log ("FAILED, left in place: {0} - {1}" -f ($g.files -join ', '), $g.error)
      }
    }
  } catch { Log "UPLOAD ERROR (will retry): $($_.Exception.Message)" }
}

Log "Watcher started on $root"
while ($true) {
  try {
    # Subfolders: each one is a single (possibly multi-photo) receipt.
    Get-ChildItem -LiteralPath $root -Directory | Where-Object { $_.Name -ne 'Done' } | ForEach-Object {
      $dir = $_
      $all = @(Get-ChildItem -LiteralPath $dir.FullName -File | Where-Object { $Exts -contains $_.Extension.ToLower() })
      if ($all.Count -gt 0 -and -not ($all | Where-Object { -not (Is-Ready $_) })) {
        Process-Batch ($all | Sort-Object Name) 'folder' $dir.Name
        if (-not (Get-ChildItem -LiteralPath $dir.FullName -Force)) { Remove-Item -LiteralPath $dir.FullName }
      }
    }
    # Loose files: server guesses which belong together.
    $loose = @(Get-ChildItem -LiteralPath $root -File | Where-Object { ($Exts -contains $_.Extension.ToLower()) -and (Is-Ready $_) })
    Process-Batch $loose 'auto' $null
  } catch { Log "LOOP ERROR: $($_.Exception.Message)" }
  Start-Sleep -Seconds 20
}
