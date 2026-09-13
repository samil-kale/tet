# Installs TET on Windows, or replaces the one installed:
#
#   irm https://raw.githubusercontent.com/samil-kale/tet/development/scripts/install.ps1 | iex
#
# Fetches the newest release's archive for this machine (electron-builder.yml builds them, named
# as src/shared/release.ts's `assetName`) and unpacks it for this user alone, no administrator
# asked: %LOCALAPPDATA%\Programs\TET, a Start menu entry and a desktop icon, and `tet` on the
# user's PATH. The app updates itself from then on (src/main/auto-update.ts), in the same folder.
#
# The Start menu entry is TET.lnk pointing at TET.exe, which is also what Electron writes on the
# first toast (see main.ts's APP_USER_MODEL_ID): it rewrites this very entry with the
# AppUserModelID and toast activator on it, rather than adding one of its own. TET_RELEASES_URL
# stands in for GitHub's releases in test/install.test.ts.
#
# Run through iex, in the user's own session: a block, so nothing it defines stays behind, and
# `throw` rather than `exit`, which would close their window.

& {
  $ErrorActionPreference = 'Stop'
  # Invoke-WebRequest's progress bar slows a download many times over in Windows PowerShell 5.1.
  $ProgressPreference = 'SilentlyContinue'
  # Windows PowerShell 5.1 may still offer only TLS 1.0, which GitHub refuses.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $releases = if ($env:TET_RELEASES_URL) { $env:TET_RELEASES_URL } else { 'https://github.com/samil-kale/tet/releases' }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
  $asset = "TET-win-$arch.zip"
  $dest = Join-Path $env:LOCALAPPDATA 'Programs\TET'
  $exe = Join-Path $dest 'TET.exe'

  # Replacing the files of a running TET takes its sessions down with it, and win32 refuses anyway.
  if (Get-Process -Name TET -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) {
    throw 'tet: TET is running; quit it first'
  }

  # The newest release, off the redirect GitHub answers /latest with.
  $request = [Net.HttpWebRequest]::Create("$releases/latest")
  $request.AllowAutoRedirect = $false
  $request.Method = 'HEAD'
  $response = $request.GetResponse()
  $location = $response.Headers['Location']
  $response.Close()
  if ($location -notmatch '/tag/([^/]+)$') {
    throw "tet: could not find the newest release at $releases"
  }
  $tag = $Matches[1]

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('tet-install-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "tet: downloading $asset ($tag)"
    $zip = Join-Path $tmp $asset
    Invoke-WebRequest -Uri "$releases/download/$tag/$asset" -OutFile $zip -UseBasicParsing
    # Invoke-WebRequest marks nothing as downloaded from the internet; a proxy or a policy might.
    Unblock-File -Path $zip
    $unpacked = Join-Path $tmp 'unpacked'
    Expand-Archive -Path $zip -DestinationPath $unpacked
    $found = Get-ChildItem -Path $unpacked -Filter TET.exe -Recurse -Depth 1 | Select-Object -First 1
    if (-not $found) {
      throw "tet: no TET.exe in $asset"
    }
    if (Test-Path $dest) {
      Remove-Item -Path $dest -Recurse -Force
    }
    New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
    Move-Item -Path $found.DirectoryName -Destination $dest
  } finally {
    Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  $shell = New-Object -ComObject WScript.Shell
  foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
    # CreateShortcut opens an entry already there, keeping what this does not set: every field is
    # set, or an earlier install's arguments and icon stay on it.
    $link = $shell.CreateShortcut((Join-Path $folder 'TET.lnk'))
    $link.TargetPath = $exe
    $link.Arguments = ''
    $link.IconLocation = "$exe,0"
    # The folder Electron's own entry names: its entry and this one then agree (main.ts).
    $link.WorkingDirectory = $dest
    $link.Description = 'Git workspace for coding agents'
    $link.Save()
  }

  # `tet` in a new console. Read and written as the registry holds it: through [Environment] the
  # user's PATH comes back expanded and goes back as a plain string, losing every %VARIABLE% in it.
  $bin = Join-Path $dest 'bin'
  $key = Get-Item -Path 'HKCU:\Environment'
  $userPath = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  if (($userPath -split ';') -notcontains $bin) {
    $entries = @($userPath -split ';' | Where-Object { $_ }) + $bin
    Set-ItemProperty -Path 'HKCU:\Environment' -Name Path -Value ($entries -join ';') -Type ExpandString
    # A registry write tells no one; a variable set through [Environment] broadcasts the change, so
    # a console opened from Explorer from now on finds `tet`.
    [Environment]::SetEnvironmentVariable('TET_INSTALL_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('TET_INSTALL_REFRESH', $null, 'User')
    $env:Path = "$env:Path;$bin"
  }

  Write-Host "tet: installed $tag into $dest"
  Write-Host 'tet: start it from the Start menu, the desktop, or with `tet`'
}
