// Purpose: Parse agent-browser accessibility snapshot entries.
// Artifact discovery now uses exact-turn DOM capture in response-capture.mjs.
export function parseSnapshotEntries(snapshot) {
  return String(snapshot || "")
    .split("\n")
    .map((line, lineIndex) => {
      const refMatch = line.match(/\bref=(e\d+)\b/);
      if (!refMatch) return undefined;
      const kindMatch = line.match(/^\s*-\s*([^\s]+)/);
      const quotedMatch = line.match(/"([^"]*)"/);
      const valueMatch = line.match(/:\s*(.+)$/);
      return {
        line,
        lineIndex,
        ref: `@${refMatch[1]}`,
        kind: kindMatch ? kindMatch[1] : undefined,
        label: quotedMatch ? quotedMatch[1] : undefined,
        value: valueMatch ? valueMatch[1].trim() : undefined,
        disabled: /\bdisabled\b/.test(line),
      };
    })
    .filter(Boolean);
}
