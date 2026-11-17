# Takes the PR watcher back out of Herdr: restores the office main.js, the office layout and
# keys.json from the .bak-<time> copies install.ps1 left (the oldest one, i.e. from before the
# first install), then removes mods\office-prs and mods\office\prs.js.
# What it replaces is kept as *.removed-<time>, so this is undoable too.
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 [-HerdrHome <folder>]
param(
  [string]$HerdrHome = $(if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME ".config\herdr-app" })
)
$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Say($m) { Write-Host "  $m" }
function Norm($path) { ([IO.File]::ReadAllText($path)) -replace "`r`n", "`n" }
function Oldest($path) {
  Get-ChildItem -Path (Split-Path $path) -Filter "$(Split-Path $path -Leaf).bak-*" -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1
}
function Restore($path) {
  $bak = Oldest $path
  if (-not $bak) { return $false }
  Copy-Item $path "$path.removed-$stamp"
  Copy-Item -Force $bak.FullName $path
  Say "restored $(Split-Path $path -Leaf) from $($bak.Name)"
  return $true
}
function Find($node, $id) {
  if ($node.id -eq $id) { return $node }
  foreach ($c in @($node.children)) { if ($c) { $r = Find $c $id; if ($r) { return $r } } }
  return $null
}
function Strip($node) {
  if ($node.children) {
    $node.children = @(@($node.children) | Where-Object { -not ($_.content -and $_.content.mod -eq "office-prs") })
    foreach ($c in $node.children) { Strip $c }
  }
}

if (-not (Test-Path $HerdrHome)) { throw "No Herdr folder at $HerdrHome. Pass -HerdrHome <folder>." }
$mods = Join-Path $HerdrHome "mods"
Write-Host "Removing the PR watcher from $HerdrHome"

# 1. The office main.js first, so it stops importing prs.js before prs.js goes.
Write-Host "office mod"
$main = Join-Path $mods "office\main.js"
if ((Test-Path $main) -and (Norm $main).Contains('from "./prs.js"')) {
  if (-not (Restore $main)) {
    # No backup (install.ps1 copied a fresh office): take the hooks back out with the patch.
    Copy-Item $main "$main.removed-$stamp"
    Push-Location $HerdrHome
    $ErrorActionPreference = "Continue"
    & git apply -R --ignore-whitespace -p1 (Join-Path $src "patches\office-main.patch")
    $ok = $LASTEXITCODE -eq 0
    $ErrorActionPreference = "Stop"
    Pop-Location
    if (-not $ok) { throw "Couldn't take the hooks out of mods\office\main.js. Nothing else was changed." }
    Say "took the PR hooks out of main.js"
  }
} else { Say "main.js has no PR hooks" }

# 2. The layout's Pull requests block.
Write-Host "office layout"
$layout = Join-Path $HerdrHome "layouts\office.json"
if ((Test-Path $layout) -and (Norm $layout).Contains('"office-prs"')) {
  if (-not (Restore $layout)) {
    Copy-Item $layout "$layout.removed-$stamp"
    $tree = (Norm $layout) | ConvertFrom-Json
    Strip $tree
    [IO.File]::WriteAllText($layout, ($tree | ConvertTo-Json -Depth 64), $utf8)
    Say "took the Pull requests block out"
  }
} else { Say "no Pull requests block" }

# 3. ctrl-shift-g.
Write-Host "keys"
$keys = Join-Path $HerdrHome "keys.json"
if ((Test-Path $keys) -and (Norm $keys).Contains("mod.open:office-prs")) {
  if (-not (Restore $keys)) {
    Copy-Item $keys "$keys.removed-$stamp"
    $k = (Norm $keys) | ConvertFrom-Json
    $k.'layout:office'.PSObject.Properties.Remove("ctrl-shift-g")
    [IO.File]::WriteAllText($keys, ($k | ConvertTo-Json -Depth 16), $utf8)
    Say "unbound ctrl-shift-g"
  }
} else { Say "ctrl-shift-g isn't bound to the PR list" }

# 4. The addon's own files.
Write-Host "files"
$prsJs = Join-Path $mods "office\prs.js"
$prsMod = Join-Path $mods "office-prs"
if (Test-Path $prsJs) { Remove-Item -Force $prsJs; Say "removed mods\office\prs.js" }
if (Test-Path $prsMod) {
  $settings = Join-Path $prsMod "settings.js"
  if (Test-Path $settings) { Copy-Item $settings (Join-Path $HerdrHome "office-prs-settings.removed-$stamp.js"); Say "kept your settings as office-prs-settings.removed-$stamp.js" }
  Remove-Item -Recurse -Force $prsMod; Say "removed mods\office-prs"
}

Write-Host "Done. The office is back to how it was. Old copies: *.removed-$stamp (delete them whenever)."
