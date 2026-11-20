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
- Two surfaces carry the window: `app.background` is its ground (title bar row, Navigation Bar,
  status bar, the gaps), `editor.background` the islands on it (a lane's sections, the panes). The
  ground is a step lighter than the islands in a dark theme and a step darker in a light one, as
  IntelliJ's Islands; a theme whose `sideBar.background` is not deviates (step 5) to a neutral of its
  own palette, and its title bar follows. No line draws an island: its fill alone sets it off.
  `app.border` stands apart from both surfaces, as IntelliJ's: it draws the lines on the ground
  and inside an island (a card and its header, a dialog's header).
- A pane's terminal stands in its island's color: there is no `terminal.background`, a theme's value
  of it is dropped and `editor.background` paints the terminal.
- The fonts are no theme's: `--tet-font-family`, `--tet-font-size` and `--tet-editor-font-family`
  are declared once, in `styles.css`.

## Names

A variable is `--tet-` and a color name, its dots made dashes (`tab.activeBackground` is
`--tet-tab-activeBackground`). The name is VS Code's color id, so the id is what to look up in a VS
Code theme file or its color registry — except where TET calls a part of the window by its own
name:

| TET name                                                        | VS Code color id                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `navigationBar.*`, `navigationBarBadge.*`, `navigationBarTop.*` | `activityBar.*`, `activityBarBadge.*`, `activityBarTop.*`          |
| `app.background`                                                | `sideBar.background`                                               |
| `app.border`                                                    | `panel.border`                                                     |
| `sectionHeader.foreground`                                      | `sideBarSectionHeader.foreground`                                  |
| `popup.background`                                              | `editorWidget.background`                                          |
| `popup.shadow`                                                  | `widget.shadow`                                                    |
| `notice{Error,Warning,Info}Icon.foreground`                     | `notifications{Error,Warning,Info}Icon.foreground`                 |
| `graph.foreground1` … `graph.foreground5`                       | `scmGraph.foreground1` … `scmGraph.foreground5`                    |
| `graph.refColor`, `graph.remoteRefColor`, `graph.baseRefColor`  | `scmGraph.historyItemRefColor`, `…RemoteRefColor`, `…BaseRefColor` |

A renamed id is renamed everywhere TET holds it (variables, `<id>.json`, code), and a VS Code theme
taken over (step 1) is renamed by this table. The exception is an API that takes the id itself —
monaco's `defineTheme`, shiki's `theme.colors`: `theme-colors.ts` maps id to variable, and the
`popup.*` names stay `editorWidget.*` and `widget.shadow` in the theme files.

## Required and optional variables

- **Required**: every variable `dark-modern.css` declares. Every theme declares each of them,
  once, so nothing falls through from another theme (`test/shared/themes.test.ts`).
- **Optional**: a variable only some themes declare, for a color VS Code has no id for. It is read
  only behind a fallback chain that ends in a required variable, and some stylesheet reads it
  (`test/lint.test.ts`). It is the exception, not the way to theme: a theme sets one only where
  its own mark color differs from the accent.

| Optional variable                          | Falls back to                                        | Set by            |
| ------------------------------------------ | ---------------------------------------------------- | ----------------- |
| `--tet-tabMark-foreground`                 | `--tet-focusBorder`                                  | Dark/Light GitHub |
| `--tet-settings-checkboxBackground`        | `--tet-input-background`                             | Dark IntelliJ     |
| `--tet-settings-checkboxBorder`            | `--tet-input-border`                                 | Dark IntelliJ     |
| `--tet-settings-checkboxForeground`        | `--tet-input-foreground`                             | Dark IntelliJ     |

## From a VS Code theme to a TET theme

1. **Take the theme file as VS Code reads it.** Follow its `include` chain (Light Modern is
   VS Code's Light 2026, its Islands theme: `2026-light.json` over `light_modern.json` over
   `light_plus.json` over `light_vs.json`; likewise Dark Modern). Where VS Code has an Islands
   variant of a theme, that variant is the reference, never the older one. A theme shiki ships is taken
   as shiki ships it (`@shikijs/themes/<name>`); any other is the extension's theme file as it
   ships, put beside the stylesheet as `<id>.json` (comments stripped, if it has any, and
   `semanticHighlighting` and `semanticTokenColors`, which neither shiki nor monaco reads).
2. **Copy each required variable's value** from the theme's `colors`, by its id.
3. **Fill what the theme leaves unset with what VS Code would draw**, read from VS Code's color
   registry under the theme's kind (its `dark:` or `light:` branch), never eyeballed: a default
   naming another id is that id's value in the same theme, a transform (`transparent`, `lighten`,
   `darken`) is applied to it, and a border it leaves to `contrastBorder` is `#00000000`.
4. **Set TET's own values**, alike in every theme:
   - `toolbar.hoverBackground` is `#5a5d5e50`, Dark Modern's: an action button sits on rows, on a
     selected row and on plain bars, and only this translucent grey reads on all of them.
   - `tab.activeBorder` is the accent, `focusBorder`, unless the theme has a mark color of its own
     (`tab.activeBorderTop`).
   - There is no `titleBar.activeBackground`: the title bar row is part of the ground, so
     `app.background` paints it (`titleBar.activeForeground` is the theme's).
   - `app.background` and `app.border` are `sideBar.background` and `panel.border`; a theme whose
     values don't fit (the layer above) deviates by step 5.
   - There is no `terminal.background` (the layer above), no `menu.selection*` (a menu's selected
     row is drawn in `list.activeSelection*`) and no `sash.hoverBorder` (a sash hovers in
     `focusBorder`): a theme's values for them are dropped.
   - What step 3 reads from the registry as another id follows that id as the theme sets it, so
     after taking over a theme's `focusBorder` or `errorForeground`, look at every variable the
     registry derives from it.
5. **Deviate from the theme where its value doesn't fit alongside TET's other themes** —
   unreadable, invisible on its ground, drawing a line TET does not want, or reading differently
   from how the same thing looks in the themes already here — and comment it at the value, saying
   what it is instead and why: `Not the theme's <value>: …`. A token rule the theme file lacks goes
   at the end of its `tokenColors`, in a color of the theme's own, and is named in the stylesheet's
   header comment, since the JSON holds none.
6. **Wire it up**:
   - Its entry in `THEMES`: `id`, `label` (without Dark/Light), `kind` (the theme's `type`), and
     `shikiTheme`. `windowBackground` and `titleBarSymbolColor` copy `--tet-app-background`
     and `--tet-titleBar-activeForeground`, `terminalBackground` and `terminalForeground` copy
     `--tet-editor-background` and `--tet-terminal-foreground`: they are needed before the stylesheet loads,
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
  its own `--vscode-*` block from them onto its elements; TET's stylesheets never read it.
- **The window**: the four values `THEMES` copies (step 6), for the window's first paint, the
  Windows title bar overlay and an agent reading colors off the console.

## Colors not from a variable

- **Syntax colors**: shiki's token colors, from the theme's token rules.
- **The dialog overlay's dim**: `rgb(0 0 0 / 40%)`, the same over every theme.
- **xterm's hidden scrollbar and ruler**: `#00000000` in `theme-colors.ts`, invisible in every
  theme.
