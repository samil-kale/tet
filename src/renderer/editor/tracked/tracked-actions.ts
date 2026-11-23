import type { AgentId } from "../../../shared/types/agents";
import type { ProviderId, TrackedChange, TrackedFieldValue } from "../../../shared/types/providers";

export type LoadImage = (source: string) => Promise<string | undefined>;

/** What the tab does, through its issue's view outside React (`editor-views.ts`). What can be refused
 *  says so in a notice, and false where what was typed then stays. */
export interface TrackedActions {
  loadImage: LoadImage;
  /** A file of the repository a link of its text leads to. */
  openFile: (path: string) => void;
  /** Any other link of its text: an upload saved where the user picks, the rest in the browser. */
  openLink: (url: string) => void;
  comment: (body: string, internal: boolean) => Promise<boolean>;
  editComment: (id: string, body: string) => Promise<boolean>;
  deleteComment: (id: string) => Promise<void>;
  deleteIssue: () => Promise<void>;
  update: (change: TrackedChange) => void;
  /** The title changed; what the tracker refused, for the dialog that asked (`askName`). */
  rename: (title: string) => Promise<string | undefined>;
  /** What a pick field can be set to; undefined, with a notice, when the tracker cannot say. */
  fieldOptions: (fieldId: string) => Promise<string[] | undefined>;
  setField: (fieldId: string, value: TrackedFieldValue) => void;
  /** A field set; what the tracker refused, for the dialog that asked (`askFieldValue`). */
  editField: (fieldId: string, value: TrackedFieldValue) => Promise<string | undefined>;
  /** The Markdown that shows the file, once it is up. */
  upload: (file: File) => Promise<string | undefined>;
  sendToAgent: (agentId: AgentId) => void;
  /** A change request's alone: approved as the account's user. */
  approve: () => Promise<void>;
  /** A change request's alone: merged by the repository's own method, or once its checks passed. */
  merge: (whenChecksPass: boolean) => Promise<void>;
  /** A linked issue of a change request opened in its tab. */
  openIssue: (number: number) => void;
}

/** What an issue's text is rendered with. */
export interface TextRendering {
  provider: ProviderId;
  /** What a relative link leads from. */
  issueUrl: string;
  loadImage: LoadImage;
  openFile: TrackedActions["openFile"];
  openLink: TrackedActions["openLink"];
}

/** What a box writing an issue's text takes beside its value, the same for every box of the issue. */
export interface TextWriting {
  /** What the preview renders the text with. */
  rendering: TextRendering;
  /** Where the tracker takes a file for the text. */
  upload: TrackedActions["upload"] | undefined;
  /** What the picker offers, an `accept`; absent offers any file. */
  accept: string | undefined;
}
