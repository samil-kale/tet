# Themes

How TET's color themes are built, the rules every theme follows, and how a VS Code theme becomes
a TET theme. A rule that fits one value is a comment at that value, not an entry here.

## The layer

- Every UI color is a `--tet-*` custom property, set by the themes alone. Nothing else names a
  color: ESLint refuses a color literal in the renderer's code outside `src/renderer/themes/`, and
  `test/lint.test.ts` one in any other stylesheet. The exceptions are listed at the end.
- A theme is one stylesheet, `<id>.css`, declaring its variables and `color-scheme` in
  `:root[data-theme="<id>"]`, plus its entry in `THEMES` (`src/shared/themes.ts`). `main.tsx`
  imports every stylesheet and sets `data-theme` from the id, at start and on `app:theme`.
- `dark-modern.css` is also the bare `:root`, so an unknown id still gets a whole theme.
- The fonts are no theme's: `--tet-font-family`, `--tet-font-size` and `--tet-editor-font-family`
  are declared once, in `styles.css`.

## Names

A variable is `--tet-` and VS Code's color id, its dots made dashes:

| VS Code color id         | TET variable                   |
| ------------------------ | ------------------------------ |
| `foreground`             | `--tet-foreground`             |
| `tab.activeBackground`   | `--tet-tab-activeBackground`   |
| `terminal.ansiBrightRed` | `--tet-terminal-ansiBrightRed` |

So the id is the one name to look up in a VS Code theme file or VS Code's color registry. Where
an API takes the id itself — monaco's `defineTheme`, shiki's `theme.colors` — `theme-colors.ts`
maps id to variable.

## Required and optional variables

- **Required**: every variable `dark-modern.css` declares. Every theme declares each of them,
  once, so nothing falls through from another theme (`test/shared/themes.test.ts`).
- **Optional**: a variable only some themes declare, for a color VS Code has no id for. It is read
  only behind a fallback chain that ends in a required variable, and some stylesheet reads it
  (`test/lint.test.ts`). It is the exception, not the way to theme: a theme sets one only where
  its own mark color differs from the accent.

| Optional variable                  | Falls back to                                            | Set by            |
| ---------------------------------- | -------------------------------------------------------- | ----------------- |
| `--tet-tabMark-workingForeground`  | `--tet-focusBorder`                                      | Dark/Light GitHub |
| `--tet-tabMark-finishedForeground` | `--tet-focusBorder`                                      | Dark/Light GitHub |
| `--tet-tabMark-activeForeground`   | the working or finished mark's, then `--tet-focusBorder` | Light GameBoy     |

## From a VS Code theme to a TET theme

1. **Take the theme file as VS Code reads it.** Follow its `include` chain (Light Modern:
   `light_modern.json` over `light_plus.json` over `light_vs.json`). A theme shiki ships is taken
   as shiki ships it (`@shikijs/themes/<name>`); any other is the extension's theme file as it
   ships, put beside the stylesheet as `<id>.json` (comments stripped, if it has any).
2. **Copy each required variable's value** from the theme's `colors`, by its id.
3. **Fill what the theme leaves unset with what VS Code would draw**, read from VS Code's color
   registry under the theme's kind (its `dark:` or `light:` branch), never eyeballed. A registry
   default naming another id is that id's value in the same theme, and a transform (`transparent`,
   `lighten`, `darken`) is applied to it. Where the registry gives no color:
   - A border the registry leaves to `contrastBorder`, which only high contrast themes set, is
     transparent: `#00000000`.
   - Any other border takes the theme's own border color.
   - `terminal.background` takes `editor.background`, the ground the active tab stands on.
4. **Set TET's own values**, alike in every theme:
   - `toolbar.hoverBackground` is `#5a5d5e50`, Dark Modern's, whatever the theme sets: an action
     button sits on rows, on a selected row and on plain bars, and only this translucent grey
     reads on all of them.
   - `tab.activeBorder` is the accent, `focusBorder`, not the theme's `tab.activeBorder`; a theme
     with a mark color of its own (`tab.activeBorderTop`) takes that instead.
5. **Deviate from the theme only where its value fails in TET** — unreadable, invisible on its
   ground, or drawing a line TET does not want — and comment it at the value, saying what it is
   instead and why: `Not the theme's <value>: …`. A token rule the theme file lacks goes at the
   end of its `tokenColors`, in a color of the theme's own, and is named in the stylesheet's header
   comment, since the JSON holds none.
6. **Wire it up**:
   - Its entry in `THEMES`: `id`, `label` (without Dark/Light), `kind` (the theme's `type`), and
     `shikiTheme`. `windowBackground` and `titleBarSymbolColor` copy `--tet-titleBar-activeBackground`
     and `-activeForeground`, `terminalBackground` and `terminalForeground` copy
     `--tet-terminal-background` and `-foreground`: they are needed before the stylesheet loads,
     and `themes.test.ts` holds them equal.
   - Its import in `main.tsx`.
   - Token colors: a `shikiTheme` member and its line in `diff-highlight.ts`'s `THEME_MODULES`
     (shiki's module, or the `<id>.json` beside the stylesheet).
7. **Run `npm test`**: `themes.test.ts` and `lint.test.ts` check the rules above.

## Where `var()` does not reach

What draws on a canvas or takes colors through an API reads the resolved values in
`theme-colors.ts`, and reads them again on a theme switch (`main.tsx` sets `data-theme` first):

- **xterm** (`buildXtermTheme`): the terminal's background, foreground, cursor, selections and
  the sixteen ANSI colors.
- **shiki** (`EDITOR_CSS_VARS`): the editor surface, patched into the shiki theme at load
  (`diff-highlight.ts`).
- **monaco** (`MONACO_CSS_VARS`): its chrome and the diff, through `defineTheme`. monaco writes
  its own `--vscode-*` block from them onto its elements (`.monaco-editor`, `.monaco-diff-editor`,
  `.monaco-component`); TET's stylesheets never read it, only their own `--tet-*`.
- **The window**: the four values `THEMES` copies (step 6), for the window's first paint, the
  Windows title bar overlay and an agent reading colors off the console.

## Colors not from a variable

- **Syntax colors**: shiki's token colors, from the theme's token rules.
- **The dialog overlay's dim**: `rgb(0 0 0 / 40%)`, the same over every theme.
- **The four copies in `THEMES`** (step 6).
- **xterm's hidden scrollbar and ruler**: `#00000000` in `theme-colors.ts`, invisible in every
  theme.
