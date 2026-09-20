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
        macOS:    "Open in Brody.command"   (first time: right-click, Open; if macOS
                  still refuses, open Terminal and run:  bash "Open in Brody.command"
                  from inside this folder)
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
CANDIDATES="\${BRODY_URL:-http://brody:3003 http://localhost:3003 http://127.0.0.1:3003}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ZIP="$TMP/brody-export.zip"

# Keep the window open on failure when this was started by a double-click.
finish() { [ -t 0 ] && read -r -p "Press Enter to close" _; exit "$1"; }

for TOOL in zip curl; do
  command -v "$TOOL" >/dev/null 2>&1 || { echo "The '$TOOL' command is needed to send this export to Brody."; finish 1; }
done
if ! zip -qr "$ZIP" . -x "*.DS_Store"; then
  echo "Could not package this folder. On macOS, allow Terminal to read it under"
  echo "System Settings > Privacy & Security > Files and Folders (or move the folder out of Downloads/Desktop)."
  finish 1
fi

# Prints the HTTP status (000 when nothing answered). \$1 = address, \$2 = optional Host name to present.
send() {
  if [ -n "$2" ]; then
    curl -sS --connect-timeout 5 --max-time 600 -H "Host: $2" -F "file=@$ZIP" -o "$TMP/resp" -w '%{http_code}' "$1/api/projects/import-bundle" 2>"$TMP/err"
  else
    curl -sS --connect-timeout 5 --max-time 600 -F "file=@$ZIP" -o "$TMP/resp" -w '%{http_code}' "$1/api/projects/import-bundle" 2>"$TMP/err"
  fi
}

for URL in $CANDIDATES; do
  echo "Sending this export to $URL ..."
  NAME=""
  CODE="$(send "$URL" "")"
  if [ "$CODE" = "421" ]; then
    # Brody only answers to one host name (ALLOWED_HOSTS) and says which; present that name, even when reached as localhost.
    NAME="$(sed -n 's|^This app is served only at http://\\([^:/]*\\).*|\\1|p' "$TMP/resp" | head -n1)"
    if [ -n "$NAME" ]; then echo "  Brody only answers to the name '$NAME'; retrying as that."; CODE="$(send "$URL" "$NAME")"; fi
  fi
  if [ "$CODE" = "201" ]; then
    ID="$(grep -o '"id":"prj_[0-9a-f]*"' "$TMP/resp" | head -n1 | cut -d'"' -f4)"
    if [ -n "$ID" ]; then
      OPEN_URL="$URL"
      if [ -n "$NAME" ]; then
        OPEN_URL="$(printf '%s' "$URL" | sed -E "s|^(https?://)[^:/]+|\\\\1$NAME|")"
        echo "  If the page does not load, add this line to /etc/hosts:  127.0.0.1 $NAME"
      fi
      echo "Imported. Opening $OPEN_URL/p/$ID"
      (open "$OPEN_URL/p/$ID" 2>/dev/null || xdg-open "$OPEN_URL/p/$ID" 2>/dev/null)
      exit 0
    fi
  fi
  if [ "$CODE" = "000" ]; then
    echo "  No answer: $(tr '\\n' ' ' <"$TMP/err")"
  else
    MSG="$(sed -n 's/.*"message":"\\([^"]*\\)".*/\\1/p' "$TMP/resp" | head -n1)"
    echo "  Brody answered $CODE\${MSG:+: $MSG}"
  fi
done
echo
echo "Could not import into Brody. Is it running? Start it with:  brody start"
echo "If it runs at another address, set BRODY_URL and try again."
finish 1
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
