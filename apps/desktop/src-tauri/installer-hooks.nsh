; SPDX-License-Identifier: Apache-2.0
; Copyright 2026 Ashutosh Sahoo
;
; installer-hooks.nsh -- Tauri NSIS installer hooks (wired via
; bundle.windows.nsis.installerHooks in tauri.conf.json). Windows only:
; NSIS is the Windows bundler, so nothing here can affect the Linux
; (AppImage/.deb) or any future macOS bundles.
;
; B4 -- install Git for Windows when it is missing.
;
; WHY GIT, WHY AT INSTALL TIME: KriyaDot's mission pipeline (A5) and its
; coding worktrees shell out to a `git` binary (WorktreeManager /
; MissionService spawn `git` directly). Git for Windows is NOT part of
; Windows, so on a clean machine the first mission died with a raw spawn
; error ("git rev-parse failed: exit null") that reads like a KriyaDot
; bug. Fixing that first-run failure here, once, at install time, is the
; least-surprise place: every later surface can simply assume the tool
; it needs either exists or the user has already been told, in plain
; words, that it does not.
;
; WHY NON-FATAL, ALWAYS: Git is an enhancement for the mission/worktree
; features, not a dependency of KriyaDot itself -- chat, bots, office
; and everything else work without it. So NO failure in this file may
; fail, abort or roll back the KriyaDot install. Every route ends in
; either "git is present" (silent) or a single plain-words notice.
; There is deliberately NO matching uninstall hook: Git is a shared
; system tool other programs may rely on, so uninstalling KriyaDot
; must never remove it.
;
; ROUTES, IN ORDER (first one that leaves git.exe detectable wins):
;   1. winget, when present: `winget install --id Git.Git -e` -- the
;      package Microsoft's winget catalogue resolves to the same Git
;      for Windows build. Preferred because winget owns the download,
;      the hash catalogue and future upgrades.
;   2. Direct download of the official Git for Windows installer from
;      the project's own GitHub releases (github.com/git-for-windows --
;      the download git-scm.com itself links to), run silently.
;   3. Neither worked (offline, no winget, declined elevation, ...):
;      KriyaDot still installs; the user gets one MessageBox pointing
;      at git-scm.com.
;
; THREAT NOTE (route 2 downloads and executes an installer, so this is
; the sensitive part of the file):
;   - The ONLY host contacted is github.com, ONLY the git-for-windows
;     organisation, ONLY the pinned release below. No mirrors, no
;     "latest" redirect chasing beyond github.com's own asset redirect
;     (curl --location follows it to GitHub's release-asset storage).
;   - The version is PINNED and the download is SHA-256 verified
;     against the hash published in that release's own notes BEFORE
;     anything is executed. Verification failure is fail-closed: the
;     file is deleted and never run. TLS (--fail, default cert checks)
;     is only the transport layer; the hash is the integrity check.
;   - Nothing else is ever downloaded or installed by this file. The
;     Git installer runs with its vendor defaults (/VERYSILENT), which
;     is the vendor's own unattended mode; it shows its own UAC prompt
;     when it needs elevation -- that consent belongs to Git's
;     installer, not to us, and declining it just lands in route 3.
;   - TO UPDATE THE PIN: bump all four defines together from the new
;     release page's Filename/SHA-256 table at
;     github.com/git-for-windows/git/releases and re-verify the hashes
;     against that page. Never copy a hash from a third-party site.
;
; DETECTION: PATH alone is not trusted -- a just-installed Git updates
; the machine/user PATH in the registry, but THIS installer's process
; environment still holds the old PATH, so detection also checks the
; standard install locations and the GitForWindows registry key. The
; same full check re-runs after each install attempt, so "success" is
; always proven by git.exe actually being on disk, never by trusting
; an exit code alone (winget can return 0 for "already installed"
; style no-ops, and Inno returns before PATH settles).

!define KRIYADOT_GIT_TAG "2.56.0.windows.4"
!define KRIYADOT_GIT_ASSET_X64 "Git-2.56.0.4-64-bit.exe"
!define KRIYADOT_GIT_SHA256_X64 "4961a4a8cc778d8b6e00a5819e5fe4d078b754555aff7aedc2d77a5d74c2de80"
!define KRIYADOT_GIT_ASSET_ARM64 "Git-2.56.0.4-arm64.exe"
!define KRIYADOT_GIT_SHA256_ARM64 "e7dcc4adbb0eb373064598cd18bc75e60128707d816ead51cd9bd98e356f0075"

; KRIYADOT_GIT_CHECK -- sets $R4 to "1" when git.exe is detectable,
; "0" otherwise. Clobbers $R0; preserves everything else. The body uses
; ONLY relative jumps (+n) and no labels, so the macro can be inserted
; several times inside one section without label collisions.
; (NSIS relative-jump idiom used below: a jump target of 0 falls
; through to the next instruction; +2 skips exactly one instruction.)
!macro KRIYADOT_GIT_CHECK
  StrCpy $R4 "0"
  ; 1. PATH lookup (works when git predates this installer run).
  SearchPath $R0 "git.exe"
  StrCmp $R0 "" +2 0
  StrCpy $R4 "1"
  ; 2. Standard install locations (PATH-independent).
  IfFileExists "$PROGRAMFILES64\Git\cmd\git.exe" 0 +2
  StrCpy $R4 "1"
  IfFileExists "$PROGRAMFILES\Git\cmd\git.exe" 0 +2
  StrCpy $R4 "1"
  IfFileExists "$PROGRAMFILES\Git\bin\git.exe" 0 +2
  StrCpy $R4 "1"
  IfFileExists "$LOCALAPPDATA\Programs\Git\cmd\git.exe" 0 +2
  StrCpy $R4 "1"
  ; 3. Git for Windows registry InstallPath (machine, then per-user).
  ReadRegStr $R0 HKLM "SOFTWARE\GitForWindows" "InstallPath"
  StrCmp $R0 "" +3 0
  IfFileExists "$R0\cmd\git.exe" 0 +2
  StrCpy $R4 "1"
  ReadRegStr $R0 HKCU "SOFTWARE\GitForWindows" "InstallPath"
  StrCmp $R0 "" +3 0
  IfFileExists "$R0\cmd\git.exe" 0 +2
  StrCpy $R4 "1"
!macroend

; NSIS_HOOK_POSTINSTALL -- runs inside the installer section AFTER
; KriyaDot's files, registry keys and shortcuts are in place (Tauri 2
; hook semantics). POST -- not PRE -- install on purpose: KriyaDot is
; already safely installed before we touch anything, so even a hung or
; crashing Git step cannot leave a half-installed KriyaDot.
!macro NSIS_HOOK_POSTINSTALL
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  ; Register contract for this macro:
  ;   $R0 scratch (paths / env reads)   $R3 pinned SHA-256 (route 2)
  ;   $R1 winget path, then temp file   $R4 KRIYADOT_GIT_CHECK result
  ;   $R2 asset file name (route 2)     $R5 last exit code / status
  ;   $R6 unused here; saved/restored with the rest for future hooks.

  !insertmacro KRIYADOT_GIT_CHECK
  StrCmp $R4 "1" kriyadot_git_done
  ; Git is missing -- try to fix it, quietly, best route first.

  ; ---------------- Route 1: winget ----------------
  StrCpy $R1 ""
  SearchPath $R1 "winget.exe"
  StrCmp $R1 "" 0 kriyadot_git_winget
  IfFileExists "$LOCALAPPDATA\Microsoft\WindowsApps\winget.exe" 0 kriyadot_git_download
  StrCpy $R1 "$LOCALAPPDATA\Microsoft\WindowsApps\winget.exe"
kriyadot_git_winget:
  DetailPrint "KriyaDot: Git was not found on this PC. Installing Git for Windows via winget (package Git.Git)..."
  nsExec::ExecToLog /TIMEOUT=600000 '"$R1" install --id Git.Git -e --source winget --silent --accept-package-agreements --accept-source-agreements'
  Pop $R5
  !insertmacro KRIYADOT_GIT_CHECK
  StrCmp $R4 "1" kriyadot_git_installed_ok
  ; winget was absent, failed, or its install did not land -- fall
  ; through to the direct-download route instead of giving up.

  ; ---------------- Route 2: official download ----------------
kriyadot_git_download:
  ; Real architecture: an x64 installer process on ARM64 Windows sees
  ; PROCESSOR_ARCHITECTURE=AMD64 (emulation); PROCESSOR_ARCHITEW6432
  ; carries the host's true architecture when set. (x64 Git would run
  ; fine under emulation either way -- this just prefers native.)
  ReadEnvStr $R0 "PROCESSOR_ARCHITEW6432"
  StrCmp $R0 "" 0 kriyadot_git_arch_ready
  ReadEnvStr $R0 "PROCESSOR_ARCHITECTURE"
kriyadot_git_arch_ready:
  StrCpy $R2 "${KRIYADOT_GIT_ASSET_X64}"
  StrCpy $R3 "${KRIYADOT_GIT_SHA256_X64}"
  StrCmp $R0 "ARM64" 0 kriyadot_git_asset_ready
  StrCpy $R2 "${KRIYADOT_GIT_ASSET_ARM64}"
  StrCpy $R3 "${KRIYADOT_GIT_SHA256_ARM64}"
kriyadot_git_asset_ready:
  StrCpy $R1 "$TEMP\$R2"
  ; Delete any stale file first: a failed download must never be able
  ; to "verify" against leftovers from an earlier run.
  Delete "$R1"
  StrCpy $R0 ""
  SearchPath $R0 "curl.exe"
  StrCmp $R0 "" 0 kriyadot_git_curl_ready
  IfFileExists "$SYSDIR\curl.exe" 0 kriyadot_git_notice
  StrCpy $R0 "$SYSDIR\curl.exe"
kriyadot_git_curl_ready:
  DetailPrint "KriyaDot: downloading Git for Windows ${KRIYADOT_GIT_TAG} from the official git-for-windows GitHub release..."
  nsExec::ExecToLog /TIMEOUT=600000 '"$R0" --fail --location --silent --show-error --output "$R1" "https://github.com/git-for-windows/git/releases/download/v${KRIYADOT_GIT_TAG}/$R2"'
  Pop $R5
  StrCmp $R5 "0" 0 kriyadot_git_download_failed
  ; Verify BEFORE executing (fail-closed; see threat note above).
  ; Get-FileHash ships with Windows PowerShell 5.1 on every supported
  ; Windows. If PowerShell is missing the command errors, $R5 is not
  ; "0", and the download is treated as unverified -- never run.
  ; (A path containing a single quote breaks the -Command string and
  ; likewise fails closed; it can never smuggle extra commands in,
  ; because the whole comparison then simply errors out.)
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "if ((Get-FileHash -LiteralPath $\'$R1$\' -Algorithm SHA256).Hash -ieq $\'$R3$\') { exit 0 } else { exit 1 }"'
  Pop $R5
  StrCmp $R5 "0" 0 kriyadot_git_download_failed
  DetailPrint "KriyaDot: Git installer download verified (SHA-256 matches the official release). Installing Git..."
  ExecWait '"$R1" /VERYSILENT /NORESTART /SUPPRESSMSGBOXES /SP-' $R5
  Delete "$R1"
  !insertmacro KRIYADOT_GIT_CHECK
  StrCmp $R4 "1" kriyadot_git_installed_ok
  Goto kriyadot_git_notice

kriyadot_git_download_failed:
  ; Download or verification failed: remove the partial/untrusted
  ; file and take the notice path. The file is NEVER executed here.
  Delete "$R1"

  ; ---------------- Route 3: plain-words notice ----------------
kriyadot_git_notice:
  DetailPrint "KriyaDot: Git could not be installed automatically. KriyaDot itself is fully installed; only the mission / worktree features need Git. Get Git for Windows from https://git-scm.com/download/win and restart KriyaDot."
  MessageBox MB_OK|MB_ICONINFORMATION "KriyaDot has been installed.$\r$\n$\r$\nOne more tool is needed for KriyaDot's mission and worktree features: Git for Windows. It could not be installed automatically (for example, this PC may be offline).$\r$\n$\r$\nPlease install Git from git-scm.com -- https://git-scm.com/download/win -- and then restart KriyaDot.$\r$\n$\r$\nEverything else in KriyaDot works without Git." /SD IDOK
  Goto kriyadot_git_done

kriyadot_git_installed_ok:
  DetailPrint "KriyaDot: Git for Windows is now installed. Missions and worktrees can use it -- if a terminal or KriyaDot was already open, restart it so it picks up the updated PATH."

kriyadot_git_done:
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
