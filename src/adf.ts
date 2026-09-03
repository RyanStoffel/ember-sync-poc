/**
 * Atlassian Document Format conversion.
 *
 * Jira Cloud REST v3 takes descriptions and comment bodies as ADF documents,
 * not strings, while GitHub takes markdown text. Every field crossing the
 * boundary has to go through here, which is the first real friction point of
 * GitHub-Jira sync.
 */

/** Every ADF node carries a type; leaves carry `text`, containers carry `content`. */
export type AdfNode = { type: string; text?: string; content?: AdfNode[] };

export type AdfDoc = { type: "doc"; version: 1; content: AdfNode[] };

/** Plain text (GitHub markdown body) to an ADF document. */
export function toAdf(text: string): AdfDoc {
  const paragraphs = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const content: AdfNode[] = [];
  for (const paragraph of paragraphs) {
    const lines = paragraph.split("\n");
    const inline: AdfNode[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) inline.push({ type: "hardBreak" });
      const line = lines[i] ?? "";
      if (line.length > 0) inline.push({ type: "text", text: line });
    }
    content.push(inline.length > 0 ? { type: "paragraph", content: inline } : { type: "paragraph" });
  }
  return { type: "doc", version: 1, content };
}

/** ADF document back to plain text. Unknown block nodes are flattened, not dropped. */
export function fromAdf(doc: AdfDoc | null | undefined): string {
  if (!doc) return "";
  return doc.content.map(renderBlock).join("\n\n").trim();
}

function renderBlock(node: AdfNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (!node.content) return node.text ?? "";
  return node.content.map(renderBlock).join("");
}
