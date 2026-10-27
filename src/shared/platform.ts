/**
 * What differs between the operating systems TET runs on, each as what it means rather than which
 * one it is. Main (`process.platform`) and the window (`navigator`) each take theirs through
 * `platformOf`. The id is data alone: stored (tet.json's `os`), shown, or a file name.
 */
export interface Platform {
  readonly id: "win32" | "darwin" | "linux";

  // Files and names
  /** Paths compare regardless of case, as NTFS and APFS take them by default. */
  readonly pathsIgnoreCase: boolean;
  /** sbx's filesystem rules match a path regardless of case (sbx-policy.ts): only on win32, as sbx
   *  takes a macOS path as typed. */
  readonly sbxRulesIgnoreCase: boolean;
  /** Environment variable names compare regardless of case, as the win32 environment takes them. */
  readonly envNamesIgnoreCase: boolean;
  /** The native path separator, for a path handed back to the user or typed by them. */
  readonly pathSeparator: "\\" | "/";
  /** Absolute paths start with a drive letter (`C:\`), which a sandbox mounts as `/c/`. */
  readonly driveLetters: boolean;
  /** A file is executable by its extension, not an executable bit. */
  readonly executableByExtension: boolean;

  // Processes
  /** A shim or an unresolved name starts through cmd.exe (util/process.ts's resolveCommand). */
  readonly spawnsThroughCmd: boolean;
  /** A started program is ended with its children through `taskkill /T` (killProcessTree). */
  readonly killsWithTaskkill: boolean;
  /** The agents' install folders are known up front; elsewhere the login shell's PATH is read
   *  (agent-path.ts). */
  readonly agentDirsKnown: boolean;
  /** `tet-ctl` needs a `.cmd` launcher beside the POSIX one: cmd.exe finds only `.cmd` on PATH. */
  readonly cmdLauncher: boolean;
  /** A generated hook command runs in a POSIX shell (hook-target.ts): not on win32. */
  readonly posixShell: boolean;
  /** The shell tab's program: PowerShell on win32, else the user's `$SHELL`. */
  shellExecutable(env: Record<string, string | undefined>): string;
  /** The shell's arguments running one command line (a saved command). */
  shellCommandArgs(command: string): string[];
  /** A path as one word for the shell: single-quoted where it holds anything the shell reads. */
  shellQuotePath(path: string): string;
  /** The OS's own terminal window running `executable` in `cwd`, then staying open on its shell, as
   *  candidates tried in order until one starts (util/process.ts's openExternalTerminal). `variables`
   *  are exported in the line itself: a terminal that is already running hands its windows its own
   *  environment, not the one it was started with. */
  externalTerminals(
    cwd: string,
    executable: string,
    args: string[],
    env: Record<string, string | undefined>,
    variables: Record<string, string>,
  ): ExternalTerminal[];
  /** The tar that unpacks an update (the zip too: Windows' tar is bsdtar). */
  tarExecutable(env: Record<string, string | undefined>): string;

  // The app
  /** The app is a bundle (`TET.app`), not a folder around its executable. */
  readonly appBundle: boolean;
  /** The executable inside an install root (release.ts's rootExecutable). */
  readonly executableInRoot: readonly string[];
  /** The archive the release names for this platform (electron-builder.yml's `artifactName`). */
  readonly assetPrefix: string;
  readonly assetExtension: string;
  /** The README's manual install line. */
  readonly installCommand: string;
  /** The window icon; macOS reads the bundle's. */
  readonly windowIcon: "icon.ico" | "icon.png";
  /** Window controls drawn over TET's own title bar (titleBarOverlay); macOS keeps its inset lights. */
  readonly titleBarOverlay: boolean;
  /** The app name stands in the middle of the title bar. */
  readonly centersTitle: boolean;
  /** The app quits with its last window; macOS keeps it running. */
  readonly quitsWithLastWindow: boolean;
  /** Notifications go through Windows' activator (an AppUserModelID, notification XML), clicked even after TET
   *  quit; elsewhere Electron's own notification, held while it shows. */
  readonly windowsNotifications: boolean;
  /** The file whose presence keeps Docker Sandboxes' first-run wizard out of a tab (sbx-cli.ts);
   *  undefined where sbx shows none. */
  sbxFirstRunMarker(env: Record<string, string | undefined>): string | undefined;
  /** The GPU may be Wayland's or software: WebGL is checked before use (terminal-views.ts). */
  readonly checksGpu: boolean;
  /** Electron starts with `--no-sandbox` (install.sh, the tests' launch): unpacked without root, its
   *  chrome-sandbox lacks the setuid bit, and AppArmor may block the user-namespace fallback. */
  readonly startsWithoutChromeSandbox: boolean;

  // The window's words and keys
  /** The key a shortcut holds: Cmd on macOS, Ctrl elsewhere. */
  readonly modifierKey: "Meta" | "Control";
  readonly modifierLabel: string;
  /** The context menu entry showing a file in the file manager. */
  readonly revealLabel: string;
}

/** One program a terminal window is started with (Platform.externalTerminals). */
export interface ExternalTerminal {
  command: string;
  args: string[];
}

/** No `$`, backtick, quote, space or backslash (an escape). */
const posixQuote = (path: string): string => (/^[\w./:-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`);

/** A program and its arguments as one POSIX shell line, each a word of its own. */
const posixLine = (executable: string, args: string[]): string => [executable, ...args].map(posixQuote).join(" ");

/** POSIX shell commands exporting each variable, then running the program: the shell it runs under
 *  keeps the variables. */
const posixCommands = (variables: Record<string, string>, executable: string, args: string[]): string[] => [
  ...Object.entries(variables).map(([name, value]) => `export ${name}=${posixQuote(value)}`),
  posixLine(executable, args),
];

/** POSIX shells: `$SHELL`, `-c`; a `'` closed, escaped and reopened. */
const POSIX = {
  shellExecutable: (env: Record<string, string | undefined>) => env.SHELL ?? "/bin/bash",
  shellCommandArgs: (command: string) => ["-c", command],
  shellQuotePath: posixQuote,
  tarExecutable: () => "tar",
  sbxFirstRunMarker: () => undefined,
};

/** A string literal; a `'` doubled, as each typographic one PowerShell also ends the string at
 *  (‘ ’ ‚ ‛). */
const windowsLiteral = (value: string): string => `'${value.replace(/['‘-‛]/g, "$&$&")}'`;

/** A word of its own where it holds no `$`, backtick, quote, space or `,` (a PowerShell array), else
 *  a literal. Not for a value: a bare word is a command where one is read. */
const windowsQuote = (path: string): string => (/^[\w./\\:-]+$/.test(path) ? path : windowsLiteral(path));

/** PowerShell commands setting each variable, then calling the program with the call operator `&`, as
 *  a quoted first word is a string, not a program. */
const windowsCommands = (variables: Record<string, string>, executable: string, args: string[]): string[] => [
  ...Object.entries(variables).map(([name, value]) => `$env:${name} = ${windowsLiteral(value)}`),
  `& ${[executable, ...args].map(windowsQuote).join(" ")}`,
];

export const WINDOWS: Platform = {
  id: "win32",
  pathsIgnoreCase: true,
  sbxRulesIgnoreCase: true,
  envNamesIgnoreCase: true,
  pathSeparator: "\\",
  driveLetters: true,
  executableByExtension: true,
  spawnsThroughCmd: true,
  killsWithTaskkill: true,
  agentDirsKnown: true,
  cmdLauncher: true,
  posixShell: false,
  shellExecutable: () => "powershell.exe",
  // `-NoProfile`: independent of the user's profile.
  shellCommandArgs: (command) => ["-NoProfile", "-Command", command],
  shellQuotePath: windowsQuote,
  // Windows Terminal. `;` is its separator between tabs, so escaped for it.
  externalTerminals: (cwd, executable, args, _env, variables) => [
    {
      command: "wt.exe",
      args: ["-d", cwd, "powershell.exe", "-NoExit", "-Command", windowsCommands(variables, executable, args).join("; ")].map((arg) =>
        arg.replace(/;/g, "\\;"),
      ),
    },
  ],
  tarExecutable: (env) => `${env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`,
  appBundle: false,
  executableInRoot: ["TET.exe"],
  assetPrefix: "TET-win",
  assetExtension: "zip",
  installCommand: "irm https://raw.githubusercontent.com/samil-kale/tet/development/scripts/install.ps1 | iex",
  windowIcon: "icon.ico",
  titleBarOverlay: true,
  centersTitle: false,
  quitsWithLastWindow: true,
  windowsNotifications: true,
  sbxFirstRunMarker: (env) =>
    env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\DockerSandboxes\\sandboxes\\config\\first-run-import.json` : undefined,
  checksGpu: false,
  startsWithoutChromeSandbox: false,
  modifierKey: "Control",
  modifierLabel: "Ctrl",
  revealLabel: "Show in Explorer",
};

const POSIX_INSTALL = "curl -fsSL https://raw.githubusercontent.com/samil-kale/tet/development/scripts/install.sh | sh";

export const MAC: Platform = {
  ...POSIX,
  id: "darwin",
  pathsIgnoreCase: true,
  sbxRulesIgnoreCase: false,
  envNamesIgnoreCase: false,
  pathSeparator: "/",
  driveLetters: false,
  executableByExtension: false,
  spawnsThroughCmd: false,
  killsWithTaskkill: false,
  agentDirsKnown: false,
  cmdLauncher: false,
  posixShell: true,
  // Terminal.app, told by AppleScript: `open` would hand it no command. Its window keeps the shell
  // once the command ends.
  externalTerminals: (cwd, executable, args, _env, variables) => {
    const script = [`cd ${posixQuote(cwd)}`, ...posixCommands(variables, executable, args)].join(" && ");
    return [
      {
        command: "osascript",
        args: [
          "-e",
          `tell application "Terminal" to do script "${script.replace(/[\\"]/g, "\\$&")}"`,
          "-e",
          'tell application "Terminal" to activate',
        ],
      },
    ];
  },
  appBundle: true,
  executableInRoot: ["Contents", "MacOS", "TET"],
  assetPrefix: "TET-mac",
  assetExtension: "tar.gz",
  installCommand: POSIX_INSTALL,
  windowIcon: "icon.png",
  titleBarOverlay: false,
  centersTitle: true,
  quitsWithLastWindow: false,
  windowsNotifications: false,
  checksGpu: false,
  startsWithoutChromeSandbox: false,
  modifierKey: "Meta",
  modifierLabel: "⌘",
  revealLabel: "Reveal in Finder",
};

export const LINUX: Platform = {
  ...POSIX,
  id: "linux",
  pathsIgnoreCase: false,
  sbxRulesIgnoreCase: false,
  envNamesIgnoreCase: false,
  pathSeparator: "/",
  driveLetters: false,
  executableByExtension: false,
  spawnsThroughCmd: false,
  killsWithTaskkill: false,
  agentDirsKnown: false,
  cmdLauncher: false,
  posixShell: true,
  // No terminal every desktop has: the user's `$TERMINAL`, Debian's alternative, then the common
  // ones. The shell stays once the command ends.
  externalTerminals: (_cwd, executable, args, env, variables) => {
    const command = ["sh", "-c", `${posixCommands(variables, executable, args).join("; ")}; exec "\${SHELL:-sh}"`];
    return [
      ...(env.TERMINAL ? [{ command: env.TERMINAL, args: ["-e", ...command] }] : []),
      { command: "x-terminal-emulator", args: ["-e", ...command] },
      { command: "gnome-terminal", args: ["--", ...command] },
      { command: "konsole", args: ["-e", ...command] },
      { command: "xterm", args: ["-e", ...command] },
    ];
  },
  appBundle: false,
  executableInRoot: ["tet"],
  assetPrefix: "TET-linux",
  assetExtension: "tar.gz",
  installCommand: POSIX_INSTALL,
  windowIcon: "icon.png",
  titleBarOverlay: true,
  centersTitle: false,
  quitsWithLastWindow: true,
  windowsNotifications: false,
  checksGpu: true,
  startsWithoutChromeSandbox: true,
  modifierKey: "Control",
  modifierLabel: "Ctrl",
  revealLabel: "Show in your file manager",
};

/** The platform an id names (`process.platform`); any other Unix is taken as Linux. */
export function platformOf(id: string): Platform {
  return id === "win32" ? WINDOWS : id === "darwin" ? MAC : LINUX;
}

/** The platform's modifier held (Platform.modifierKey), for shortcuts, links, copy and paste. */
export function isModifierHeld(event: { ctrlKey: boolean; metaKey: boolean }, platform: Platform): boolean {
  return platform.modifierKey === "Meta" ? event.metaKey : event.ctrlKey;
}
