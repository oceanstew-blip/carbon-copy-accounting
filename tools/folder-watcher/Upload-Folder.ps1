# Upload a whole folder of receipts in one go (Windows PowerShell 5.1, nothing to install).
#
# Uses the same app address and login the receipt watcher already has (config.json next to this
# script). Every photo and PDF in the folder, including subfolders, is sent to the app as its
# own receipt. The app reads it and skips duplicates. Nothing on your computer is moved,
# renamed or deleted. A subfolder named Done is skipped.
#
#   Double-click "Upload Folder.bat"            -> a window asks you to pick the folder
#   powershell -File Upload-Folder.ps1 -Path "C:\Receipts\August"
#   powershell -File Upload-Folder.ps1 -Path "C:\Receipts\August" -DryRun     (list only, upload nothing)
#
# Same rules as the watcher: loose photos taken seconds apart with consecutive numbers may be
# suggested as one long receipt. A PDF is always one receipt.
param(
  [string]$Path,
  [switch]$DryRun,
  [switch]$Yes,                 # skip the "Upload N files?" question
  [int]$BatchSize = 10,
  [string]$ConfigPath           # testing only
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ConfigPath) { $ConfigPath = Join-Path $Here 'config.json' }
$LogPath = Join-Path $Here 'Upload-Folder.log'
$Exts = '.jpg','.jpeg','.png','.webp','.heic','.heif','.pdf'
$MaxBytes = 20MB

function Log($m) { Add-Content -Path $LogPath -Value ("{0}  {1}" -f (Get-Date -Format 's'), $m) }

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  Write-Host "Cannot find config.json. Put this script in the ReceiptWatcher folder." -ForegroundColor Red
  exit 1
}
$cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json

# Ask for the folder if none was given.
if (-not $Path) {
  Add-Type -AssemblyName System.Windows.Forms
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = 'Pick the folder of receipts to upload'
  $dlg.ShowNewFolderButton = $false
  if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { Write-Host 'No folder picked. Nothing uploaded.'; exit 0 }
  $Path = $dlg.SelectedPath
}
if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
  Write-Host "That folder does not exist: $Path" -ForegroundColor Red
  exit 1
}
$root = (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\')

# Collect files.
$all = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue)
$usable = @($all | Where-Object {
  $rel = $_.FullName.Substring($root.Length).TrimStart('\')
  $parts = $rel.Split('\')
  ($Exts -contains $_.Extension.ToLower()) -and -not ($parts.Length -gt 1 -and ($parts[0..($parts.Length - 2)] -contains 'Done'))
})
$tooBig = @($usable | Where-Object { $_.Length -gt $MaxBytes })
$files = @($usable | Where-Object { $_.Length -le $MaxBytes } | Sort-Object FullName)
$ignored = $all.Count - $usable.Count

Write-Host ""
Write-Host "Folder: $root"
Write-Host ("Found {0} receipt file(s). {1} other file(s) ignored." -f $files.Count, $ignored)
foreach ($f in $tooBig) { Write-Host ("  Too big (over 20 MB), skipped: {0}" -f $f.Name) -ForegroundColor Yellow }
if ($files.Count -eq 0) { Write-Host 'Nothing to upload.'; exit 0 }

if ($DryRun) {
  $files | ForEach-Object { Write-Host ("  " + $_.FullName.Substring($root.Length).TrimStart('\')) }
  Write-Host 'Dry run: nothing was uploaded.'
  exit 0
}

if (-not $Yes) {
  $a = Read-Host ("Upload {0} file(s) to {1}? (y/n)" -f $files.Count, $cfg.url)
  if ($a -notmatch '^(y|yes)$') { Write-Host 'Cancelled. Nothing uploaded.'; exit 0 }
}

# Same login the watcher uses (password is stored encrypted for this Windows user).
if ($cfg.pass_plain) { $password = $cfg.pass_plain } else {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(($cfg.pass | ConvertTo-SecureString))
  $password = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
}
$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromMinutes(10)
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($cfg.user):$password"))
$http.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Basic', $basic)

function Send-Batch($batch) {
  $form = New-Object System.Net.Http.MultipartFormDataContent
  $form.Add((New-Object System.Net.Http.StringContent('auto')), 'mode')
  $mtimes = @($batch | ForEach-Object { [int64]([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeMilliseconds() })
  $form.Add((New-Object System.Net.Http.StringContent((ConvertTo-Json -InputObject $mtimes -Compress))), 'mtimes')
  foreach ($f in $batch) {
    $part = New-Object System.Net.Http.ByteArrayContent(, [IO.File]::ReadAllBytes($f.FullName))
    $form.Add($part, 'files', $f.Name)
  }
  $resp = $http.PostAsync("$($cfg.url)/api/receipts/inbox", $form).GetAwaiter().GetResult()
  $body = $resp.Content.ReadAsStringAsync().Result
  if (-not $resp.IsSuccessStatusCode) {
    if ([int]$resp.StatusCode -eq 401) { throw 'The app said the login is wrong (401). Re-run the watcher setup to save the current login.' }
    throw "Server said $([int]$resp.StatusCode): $body"
  }
  return ($body | ConvertFrom-Json)
}

$new = 0; $dup = 0; $failed = 0
Log "Start: $root ($($files.Count) files)"
for ($i = 0; $i -lt $files.Count; $i += $BatchSize) {
  $end = [Math]::Min($i + $BatchSize, $files.Count) - 1
  $batch = @($files[$i..$end])
  Write-Host ("Uploading {0}-{1} of {2} ..." -f ($i + 1), ($end + 1), $files.Count)
  try {
    $res = Send-Batch $batch
    foreach ($g in $res.groups) {
      $names = $g.files -join ', '
      if ($g.status -eq 'ingested' -and $g.split) {
        $new += [int]$g.newCount; $dup += [int]$g.duplicateCount; $failed += [int]$g.failedCount
        Write-Host ("  CUT APART:  {0} - held {1} receipts ({2} new). Check the cuts in Needs Review." -f $names, $g.split, $g.newCount)
        Log ("cut apart: $names into $($g.split) (new=$($g.newCount) dup=$($g.duplicateCount) failed=$($g.failedCount))")
      }
      elseif ($g.status -eq 'ingested') { $new++; Write-Host "  new:        $names" ; Log "new: $names" }
      elseif ($g.status -eq 'duplicate') { $dup++; Write-Host "  duplicate:  $names" ; Log "duplicate: $names" }
      else { $failed++; Write-Host "  FAILED:     $names - $($g.error)" -ForegroundColor Red; Log "FAILED: $names - $($g.error)" }
    }
  } catch {
    $failed += $batch.Count
    Write-Host ("  FAILED batch: " + $_.Exception.Message) -ForegroundColor Red
    Log ("FAILED batch starting " + $batch[0].Name + ": " + $_.Exception.Message)
    if ($_.Exception.Message -match '401') { break }
  }
}
Write-Host ""
Write-Host ("Done. {0} new, {1} already in the app, {2} failed." -f $new, $dup, $failed)
Log "Done: new=$new duplicate=$dup failed=$failed"
