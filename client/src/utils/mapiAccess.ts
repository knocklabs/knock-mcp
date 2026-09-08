export type CodeModeAccessMode = "read" | "read_write";
export type MapiAccessMode = CodeModeAccessMode;
export type ApiAccessMode = CodeModeAccessMode;

export function isMapiCodeModeEnabled(readEnabled: boolean, manageEnabled: boolean): boolean {
  return isCodeModeEnabled(readEnabled, manageEnabled);
}

export function isCodeModeEnabled(readEnabled: boolean, manageEnabled: boolean): boolean {
  return readEnabled || manageEnabled;
}

export function deriveMapiAccessMode(
  readEnabled: boolean,
  manageEnabled: boolean,
): MapiAccessMode | undefined {
  return deriveCodeModeAccessMode(readEnabled, manageEnabled);
}

export function deriveCodeModeAccessMode(
  readEnabled: boolean,
  manageEnabled: boolean,
): CodeModeAccessMode | undefined {
  if (!isCodeModeEnabled(readEnabled, manageEnabled)) return undefined;
  if (manageEnabled) return "read_write";
  return "read";
}
