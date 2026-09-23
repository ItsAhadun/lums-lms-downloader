#!/usr/bin/env sh
# Package the extension for distribution.
# Git Bash on Windows usually has no `zip`, so fall back to .NET's ZipFile.
# (Compress-Archive is deliberately NOT used: it writes backslash separators,
# which violate the ZIP spec and can break loading the packed extension.)
set -eu

VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -1)
OUT="lums-lms-downloader-${VERSION}.zip"
FILES="manifest.json background.js content.js links.js content.css offscreen.html offscreen.js popup.html popup.js popup.css sync.html sync.js sync.css lib icons README.md"

rm -f "$OUT"

if command -v zip >/dev/null 2>&1; then
  zip -rq "$OUT" $FILES
else
  ZIP_OUT="$OUT" ZIP_FILES="$FILES" powershell -NoProfile -Command '
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $root = (Get-Location).Path
    $dest = Join-Path $root $env:ZIP_OUT
    $zip = [IO.Compression.ZipFile]::Open($dest, "Create")
    try {
      foreach ($f in ($env:ZIP_FILES -split " ")) {
        $full = Join-Path $root $f
        $files = if (Test-Path $full -PathType Container) {
          Get-ChildItem -Recurse -File $full
        } else { Get-Item $full }
        foreach ($item in $files) {
          # Entry names must use forward slashes; both CreateFromDirectory and
          # Compress-Archive emit backslashes on .NET Framework.
          $rel = $item.FullName.Substring($root.Length + 1).Replace("\", "/")
          [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $item.FullName, $rel) | Out-Null
        }
      }
    } finally { $zip.Dispose() }
  '
fi

echo "$OUT"
