export interface SnapshotEntry {
  line: string;
  lineIndex: number;
  ref: string;
  kind?: string;
  label?: string;
  value?: string;
  disabled: boolean;
}

export function parseSnapshotEntries(snapshot: string): SnapshotEntry[];
