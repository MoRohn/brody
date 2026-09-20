/** Files shipped inside every Brody bundle: a README and one-click launchers for macOS, Linux and Windows. */

export const README_TEXT = (projectName: string): string => `BRODY EXPORT: ${projectName}
${"=".repeat(Math.max(20, 15 + projectName.length))}

This ZIP holds a complete Brody analysis: findings, explanations, architecture,
code map, ask history, the source code (with detected secrets redacted) and
ready-made reports. Three ways to use it:

1. OPEN IT IN BRODY (full interface: review, explain, map, files, ask, export)
   a. Start Brody, open its home page and drag this ZIP onto "Open a Brody
      export" (or choose it under Select your code). No re-analysis is run.
   b. Or double-click the launcher for your system in this folder, after
      unzipping it:
        macOS:    "Open in Brody.command"   (first time: right-click, Open)
        Linux:    open-in-brody.sh
        Windows:  "Open in Brody.bat"
      The launcher sends this export to the Brody running at http://brody:3003
      (or http://localhost:3003) and opens the imported project in your
      browser. To use another address, set BRODY_URL first, for example:
        BRODY_URL=http://192.168.1.20:3003 ./open-in-brody.sh

2. READ IT WITHOUT BRODY
   Open reports/Report.html in any browser, or reports/Report.pdf and
   reports/Report.docx. reports/Complete-Technical-Report.md has every detail.

3. USE THE DATA
   data/*.json holds the raw analysis (files, symbols, relationships, findings)
   and source/ holds the code as it was analysed.

Notes
- Importing creates a new project; importing the same file twice makes two copies.
- API keys and tokens are never included. Anything that looks like a credential
  in the source has been replaced with a redaction marker.
- The bundle has a version number; a Brody that is too old will say so.
`;

export const LAUNCHER_SH = `#!/bin/bash
# Imports this Brody export into a running Brody and opens it in your browser.
# Brody must be running (start it with:  brody start).
# To use another address:  BRODY_URL=http://host:3003 ./open-in-brody.sh
cd "$(dirname "$0")" || exit 1
CANDIDATES="\${BRODY_URL:-http://brody:3003 http://localhost:3003}"
TMP="$(mktemp -d)"
ZIP="$TMP/brody-export.zip"
if ! command -v zip >/dev/null 2>&1; then
  echo "The 'zip' command is needed to send this export to Brody."
  read -r -p "Press Enter to close"; exit 1
fi
zip -qr "$ZIP" . -x "*.DS_Store"
for URL in $CANDIDATES; do
  echo "Sending this export to $URL ..."
  if RESP="$(curl -fsS --max-time 600 -F "file=@$ZIP" "$URL/api/projects/import-bundle" 2>/dev/null)"; then
    ID="$(printf '%s' "$RESP" | sed -n 's/.*"id":"\\(prj_[0-9a-f]*\\)".*/\\1/p' | head -n1)"
    if [ -n "$ID" ]; then
      echo "Imported. Opening $URL/p/$ID"
      (open "$URL/p/$ID" 2>/dev/null || xdg-open "$URL/p/$ID" 2>/dev/null)
      rm -rf "$TMP"; exit 0
    fi
  fi
done
echo
echo "Could not import into Brody. Is it running? Start it with:  brody start"
echo "If it runs at another address, set BRODY_URL and try again."
rm -rf "$TMP"; read -r -p "Press Enter to close"; exit 1
`;

// tar.exe (Windows 10 and later) writes a standard ZIP; PowerShell's Compress-Archive can write backslash paths that Brody rejects.
export const LAUNCHER_BAT = [
  "@echo off",
  "setlocal",
  'cd /d "%~dp0"',
  'if not defined BRODY_URL set "BRODY_URL=http://brody:3003"',
  'set "TMPZIP=%TEMP%\\brody-export-%RANDOM%.zip"',
  'tar.exe -a -cf "%TMPZIP%" *',
  'curl.exe -fsS -F "file=@%TMPZIP%" "%BRODY_URL%/api/projects/import-bundle" -o "%TEMP%\\brody-import.json"',
  "if errorlevel 1 (",
  "  echo Could not import into Brody at %BRODY_URL%. Is it running? Start it with: brody start",
  "  pause",
  "  exit /b 1",
  ")",
  'for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "(Get-Content -Raw \'%TEMP%\\brody-import.json\' | ConvertFrom-Json).project.id"`) do set "ID=%%I"',
  'start "" "%BRODY_URL%/p/%ID%"',
  'del "%TMPZIP%" 2>nul',
  "",
].join("\r\n");
