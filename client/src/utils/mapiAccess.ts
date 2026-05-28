export type MapiAccessMode = "read" | "read_write";

export function isMapiCodeModeEnabled(readEnabled: boolean, manageEnabled: boolean): boolean {
  return readEnabled || manageEnabled;
}

export function deriveMapiAccessMode(
  readEnabled: boolean,
  manageEnabled: boolean,
): MapiAccessMode | undefined {
  if (!isMapiCodeModeEnabled(readEnabled, manageEnabled)) return undefined;
  if (manageEnabled) return "read_write";
  return "read";
}
