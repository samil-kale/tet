# electron-builder includes this file into the NSIS installer and uninstaller by default.

# Replaces electron-builder's check for a running TET, which starts powershell.exe (or cmd.exe with
# tasklist) right after launch. Measured with Sophos' exploit mitigation: the 0.5.0 installer,
# opened from the browser's download bar, was blocked as 'Lockdown' half a second after it
# started; the same build with this macro emptied installed without an alert. Left empty: the
# installer no longer detects or kills a running TET — a hard kill would end live agent sessions
# anyway, and the auto-update installs only once the app has quit.
!macro customCheckAppRunning
!macroend
