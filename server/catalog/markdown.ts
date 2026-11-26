// Splits the synced skill docs into heading sections, so get_component_docs can answer with the part of a
// file that covers one component instead of the whole file.

/** A Markdown ATX heading: its hashes and its text. */
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** A fenced code block's opening or closing line. Headings inside one are code, not structure. */
const FENCE = /^\s*(```|~~~)/;

/** The marker the cubeui docs put before a component's props table. */
const PROPS_MARKER = /^<!-- props:([A-Za-z_$][\w$]*) -->/;

/** YAML front matter at the top of a file. */
const FRONT_MATTER = /^---\n[\s\S]*?\n---\n/;

/** One heading and what sits under it, up to the next heading of the same or a higher rank. */
export interface DocSection {
  /** The doc's path under docs/, `layout/cards.md`. */
  file: string;
  heading: string;
  /** 1 for `#`, 2 for `##` … */
  level: number;
  /** The heading line and everything under it, subsections included. */
  text: string;
  /** The components whose props table is in this section's own lines (not a subsection's). */
  props: string[];
}

/** One synced doc. */
export interface DocFile {
  /** Its path under docs/, `layout/cards.md`. */
  path: string;
  text: string;
}

/**
 * Drops a file's YAML front matter.
 *
 * @param text - The Markdown.
 * @returns The text after the front matter, or the text unchanged when there is none.
 */
export function stripFrontMatter(text: string): string {
  return text.replace(FRONT_MATTER, '').trimStart();
}

/**
 * Splits one doc into its heading sections.
 *
 * @param doc - The doc.
 * @returns Every section, in file order; a section's text includes its subsections.
 */
export function splitSections(doc: DocFile): DocSection[] {
  const lines = doc.text.split('\n');
  const headings: { line: number; level: number; heading: string }[] = [];
  const markers: { line: number; name: string }[] = [];
  let isInFence = false;
  for (const [index, line] of lines.entries()) {
    if (FENCE.test(line)) {
      isInFence = isInFence === false;
      continue;
    }
    if (isInFence) {
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      headings.push({ line: index, level: heading[1]?.length ?? 1, heading: heading[2] ?? '' });
      continue;
    }
    const marker = PROPS_MARKER.exec(line);
    if (marker?.[1] !== undefined) {
      markers.push({ line: index, name: marker[1] });
    }
  }
  return headings.map((start, position) => {
    const following = headings.slice(position + 1);
    const end = following.find((next) => next.level <= start.level)?.line ?? lines.length;
    const ownEnd = following[0]?.line ?? lines.length;
    const props = markers
      .filter((marker) => marker.line > start.line && marker.line < ownEnd)
      .map((marker) => marker.name);
    return {
      file: doc.path,
      heading: start.heading,
      level: start.level,
      text: lines.slice(start.line, end).join('\n').trimEnd(),
      props,
    };
  });
}
