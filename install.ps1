# Installs the PR watcher into Herdr: the office-prs mod, the office's corkboard (prs.js plus
# a few lines in main.js), a "Pull requests" block in the office layout's sidebar, and
# ctrl-shift-g. Everything it replaces is kept beside it as *.bak-<time>.
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 [-HerdrHome <folder>]
param(
  [string]$HerdrHome = $(if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME ".config\herdr-app" })
)
$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Say($m) { Write-Host "  $m" }
function Backup($path) { if (Test-Path $path) { Copy-Item $path "$path.bak-$stamp"; Say "kept your old one as $(Split-Path $path -Leaf).bak-$stamp" } }
function Norm($path) { ([IO.File]::ReadAllText($path)) -replace "`r`n", "`n" }
function Hash($text) {
  $sha = [Security.Cryptography.SHA256]::Create()
  ($sha.ComputeHash($utf8.GetBytes($text)) | ForEach-Object { $_.ToString("X2") }) -join ""
}
function Find($node, $id) {
  if ($node.id -eq $id) { return $node }
  foreach ($c in @($node.children)) { if ($c) { $r = Find $c $id; if ($r) { return $r } } }
  return $null
}

if (-not (Test-Path $HerdrHome)) { throw "No Herdr folder at $HerdrHome. Pass -HerdrHome <folder> (it holds layouts\ and mods\)." }
$mods = Join-Path $HerdrHome "mods"
$layouts = Join-Path $HerdrHome "layouts"
Write-Host "Installing into $HerdrHome"

# 1. The addon mod.
Write-Host "office-prs mod"
$prsDir = Join-Path $mods "office-prs"
New-Item -ItemType Directory -Force $prsDir | Out-Null
foreach ($f in "main.js", "github.js", "mod.json") { Copy-Item -Force (Join-Path $src "mods\office-prs\$f") $prsDir }
$settings = Join-Path $prsDir "settings.js"
if (Test-Path $settings) { Say "copied (kept your settings.js)" }
else { Copy-Item (Join-Path $src "mods\office-prs\settings.js") $settings; Say "copied (settings in mods\office-prs\settings.js)" }

# 2. The office: prs.js, and the hooks in main.js.
Write-Host "office mod"
$office = Join-Path $mods "office"
if (-not (Test-Path $office)) {
  Copy-Item -Recurse (Join-Path $src "mods\office") $mods
  Say "office wasn't installed: copied the whole office (with the PR board)"
} else {
  Copy-Item -Force (Join-Path $src "mods\office\prs.js") $office
  $main = Join-Path $office "main.js"
  $text = Norm $main
  $upstream = "631CA0C45569F9F99EC68D1611FCC0AB8B4E79BC1891878F699CABC6AD23B8C6"
  if ($text.Contains('from "./prs.js"')) { Say "main.js already has the PR hooks" }
  elseif ((Hash $text) -eq $upstream) { Backup $main; Copy-Item -Force (Join-Path $src "mods\office\main.js") $main; Say "main.js updated" }
  else {
    # Your main.js differs from DustyPolk/herdr-office (WEATHER on, your own tweaks...): patch it.
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { throw "Your office main.js has changes and git isn't on PATH to patch it. Apply patches\office-main.patch by hand." }
    Backup $main
    Push-Location $HerdrHome
    try {
      $ErrorActionPreference = "Continue"
      & git apply --ignore-whitespace -p1 (Join-Path $src "patches\office-main.patch")
      if ($LASTEXITCODE -ne 0) { throw "patch didn't apply" }
      Say "main.js patched (your changes kept)"
    } catch {
      Copy-Item -Force "$main.bak-$stamp" $main
      throw "Couldn't patch your office main.js (left as it was). Apply patches\office-main.patch by hand, or ask your Herdr agent to."
    } finally { $ErrorActionPreference = "Stop"; Pop-Location }
  }
}

# 3. A Pull requests block under Spaces in the office layout's sidebar.
Write-Host "office layout"
$layout = Join-Path $layouts "office.json"
if (-not (Test-Path $layout)) {
  New-Item -ItemType Directory -Force $layouts | Out-Null
  Copy-Item (Join-Path $src "layouts\office.json"), (Join-Path $src "layouts\office.svg") $layouts
  Say "copied the office layout"
} elseif ((Norm $layout).Contains('"office-prs"')) { Say "already has the Pull requests block" }
else {
  $tree = (Norm $layout) | ConvertFrom-Json
  $lists = Find $tree "sidebar-lists"
  if (-not $lists) { $lists = Find $tree "sidebar" }
  if (-not $lists) { Say "no sidebar found: add { `"content`": { `"mod`": `"office-prs`" } } where you want it"; }
  else {
    $block = [pscustomobject]@{ id = "prs"; type = "block"; content = [pscustomobject]@{ mod = "office-prs" }; size = [pscustomobject]@{ weight = 1 }; min = 90 }
    $lists.children = @($lists.children) + $block
    Backup $layout
    [IO.File]::WriteAllText($layout, ($tree | ConvertTo-Json -Depth 64), $utf8)
    Say "added the Pull requests block to the sidebar"
  }
}

# 4. ctrl-shift-g opens the list, while the office layout shows.
Write-Host "keys"
$keys = Join-Path $HerdrHome "keys.json"
if (-not (Test-Path $keys)) { Say "no keys.json: add `"layout:office`": { `"ctrl-shift-g`": `"mod.open:office-prs`" } to yours" }
else {
  $k = (Norm $keys) | ConvertFrom-Json
  if (-not $k.'layout:office') { $k | Add-Member -NotePropertyName "layout:office" -NotePropertyValue ([pscustomobject]@{}) }
  $section = $k.'layout:office'
  if ($section.'ctrl-shift-g') { Say "ctrl-shift-g is already bound to $($section.'ctrl-shift-g'): left it" }
  else {
    $section | Add-Member -NotePropertyName "ctrl-shift-g" -NotePropertyValue "mod.open:office-prs"
    Backup $keys
    [IO.File]::WriteAllText($keys, ($k | ConvertTo-Json -Depth 16), $utf8)
    Say "ctrl-shift-g opens the pull requests"
  }
}

# 5. Check. (Native programs' stderr mustn't stop the script on Windows PowerShell 5.1.)
Write-Host "checks"
$ErrorActionPreference = "Continue"
$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) { Say "gh isn't on PATH: install it (winget install GitHub.cli) and run gh auth login" }
else { & gh auth status 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { Say "gh isn't signed in: run gh auth login" } else { Say "gh is signed in" } }
$app = Get-Command herdr-app -ErrorAction SilentlyContinue
if ($app) {
  foreach ($m in "office-prs", "office") { & herdr-app check (Join-Path $mods $m); if ($LASTEXITCODE -ne 0) { Say "check failed for $m (see above)" } else { Say "$m passes herdr-app check" } }
} else { Say "herdr-app isn't on PATH: run herdr-app check on mods\office-prs and mods\office yourself" }
Write-Host "Done. In Herdr: herdr-app do layout.switch --name office"
