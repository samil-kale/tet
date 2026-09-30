import * as path from "node:path";
import { strFromU8, unzipSync } from "fflate";

/** OpenDocument text documents, whose body is `content.xml` in a ZIP. */
const ODF_EXTENSIONS = new Set([".odt", ".ott"]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function isOdf(filePath: string): boolean {
  return ODF_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function decode(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (whole, dec, hex, name) => {
    if (name) {
      return ENTITIES[name] ?? whole;
    }
    return String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16));
  });
}

/** One line per paragraph, heading and list item, tabs between a table's cells; formatting and
 *  images are not in it. */
function contentToText(xml: string): string {
  const body = xml.slice(xml.indexOf("<office:text"));
  return decode(
    body
      .replace(/<text:tab\/>/g, "\t")
      .replace(/<text:line-break\/>/g, "\n")
      .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_, count) => " ".repeat(count ? Number(count) : 1))
      .replace(/<\/table:table-cell>/g, "\t")
      .replace(/<\/text:(?:p|h)>|<\/table:table-row>/g, "\n")
      .replace(/<text:list-item[^>]*>/g, "- ")
      .replace(/<[^>]*>/g, "")
  )
    .replace(/\t+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** The text of an ODF document, for a diff; undefined for any other file, and for one that is not
 *  a readable ODF or whose `content.xml` unpacks past `maxBytes`. */
export function odfText(filePath: string, content: Buffer, maxBytes: number): string | undefined {
  if (!isOdf(filePath)) {
    return undefined;
  }
  try {
    const files = unzipSync(content, { filter: (file) => file.name === "content.xml" && file.originalSize <= maxBytes });
    const xml = files["content.xml"];
    return xml ? contentToText(strFromU8(xml)) : undefined;
  } catch {
    return undefined;
  }
}
