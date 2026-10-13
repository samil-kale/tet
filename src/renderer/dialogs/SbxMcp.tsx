import { useState } from "react";
import { SBX_MCP_NEEDS_AUTH, type SbxRegisteredMcp } from "../../shared/types/sbx";
import { useAnchoredMenu, type ContextMenuEntry } from "../ui/ContextMenu";
import { IconButton } from "../ui/IconButton";
import { LogInIcon } from "../ui/icons";
import { EditRow, patched, RowInput, RowSection, typedRows, withId, type Row } from "../ui/RowSection";

/** An MCP row: `picked` ones come from the picker, so sbx has them registered, and only show. */
export type McpRow = Row<{ name: string; url: string; picked?: boolean }>;

export const BLANK_MCP = { name: "", url: "" };

export function isEmptyMcpRow(row: McpRow): boolean {
  return row.name.trim() === "" && row.url.trim() === "";
}

export const MCP_NEEDS_SIGN_IN = "Needs a sign-in";

/** `name` is registered with sbx and waits for its browser sign-in. */
export function needsSignIn(registered: SbxRegisteredMcp[] | undefined | null, name: string): boolean {
  return registered?.some((server) => server.name === name && server.status === SBX_MCP_NEEDS_AUTH) ?? false;
}

interface SbxMcpSectionProps {
  rows: McpRow[];
  /** What sbx has registered, asked by the dialog for the tab's mark too: `null` until asked,
   *  `undefined` when sbx could not say. */
  registered: SbxRegisteredMcp[] | undefined | null;
  /** Asks sbx for its registered servers again. */
  ask: () => void;
  setRows: (change: (rows: McpRow[]) => McpRow[]) => void;
  /** A row's mark, or `undefined`, given what sbx said on refusing its sign-in. */
  markOf: (row: McpRow, failure: string | undefined) => string | undefined;
  /** The browser sign-in of a registered server, which waits on the user: what sbx said on
   *  refusing, else undefined. The dialog holds its bar and Cancel. */
  onSignIn: (name: string) => Promise<string | undefined>;
  /** One is running: the others' links wait. */
  signingIn: boolean;
}

/**
 * The MCP tab: a row per server, typed (name and URL, registered with sbx at Save when it is not
 * yet) or picked from those sbx has registered already, which only show. The picker's list is
 * asked each time it opens, as servers are registered outside TET.
 */
export function SbxMcpSection({ rows, registered, ask, setRows, markOf, onSignIn, signingIn }: SbxMcpSectionProps) {
  /** What sbx said on refusing a sign-in, by server: the row's mark until one succeeds. */
  const [failures, setFailures] = useState<Record<string, string | undefined>>({});
  const menu = useAnchoredMenu((rect) => ({ x: rect.left, y: rect.bottom }));
  const typed = typedRows("server", BLANK_MCP, setRows);

  const signIn = async (name: string): Promise<void> => {
    const failed = await onSignIn(name);
    setFailures((current) => ({ ...current, [name]: failed }));
    ask();
  };

  const entries = (): ContextMenuEntry[] => {
    if (registered === null) {
      return [{ label: "Loading" }];
    }
    if (registered === undefined) {
      return [{ label: "SBX did not list its MCP servers" }];
    }
    const offered = registered.filter((server) => !rows.some((row) => row.name.trim() === server.name));
    if (offered.length === 0) {
      return [{ label: "No other server is registered" }];
    }
    return offered.map((server) => ({
      label: server.name,
      // A blank row stands in for none (`atLeastOne`): the pick takes its place.
      run: () =>
        setRows((current) => [
          ...current.filter((row) => !isEmptyMcpRow(row)),
          withId({ name: server.name, url: server.url, picked: true }),
        ]),
    }));
  };

  return (
    <RowSection
      label="MCP servers"
      rows={rows}
      renderRow={(row) => {
        const name = row.name.trim();
        const signInWaits = needsSignIn(registered, name);
        return (
          <EditRow
            key={row.id}
            mark={markOf(row, failures[name])}
            action={
              signInWaits && (
                <IconButton title={`Sign in to ${name}`} disabled={signingIn} onClick={() => void signIn(name)}>
                  <LogInIcon />
                </IconButton>
              )
            }
            {...typed.remove(row.id)}
          >
            <RowInput
              width="fixed"
              placeholder="name"
              readOnly={row.picked}
              value={row.name}
              onChange={(name) => setRows((current) => patched(current, row.id, { name }))}
            />
            <RowInput
              placeholder="https://mcp.example.com/mcp"
              title="The server's URL, which sbx registers it from"
              readOnly={row.picked}
              value={row.url}
              onChange={(url) => setRows((current) => patched(current, row.id, { url }))}
            />
          </EditRow>
        );
      }}
      add={
        <div className="sbx-mcp-add">
          {typed.add}
          <button
            type="button"
            className="action-link"
            onMouseDown={(event) => {
              ask();
              menu.open(event);
            }}
          >
            + Add registered server…
          </button>
          {menu.render(entries, "dropdown-menu")}
        </div>
      }
    />
  );
}
