import type { ApiAccessMode, CodeModeAccessMode, MapiAccessMode } from "../types";
import { CODE_MODE_API_GROUP_KEY, CODE_MODE_MAPI_GROUP_KEY } from "../tool-groups";

/** Whether Management API code mode is enabled from Read/Manage consent toggles. */
export function isMapiCodeModeEnabled(readEnabled: boolean, manageEnabled: boolean): boolean {
  return readEnabled || manageEnabled;
}

/** Map Read/Manage toggles to session-level Management API access (read vs read+write tools). */
export function deriveMapiAccessMode(
  readEnabled: boolean,
  manageEnabled: boolean,
): MapiAccessMode | undefined {
  return deriveCodeModeAccessMode(readEnabled, manageEnabled);
}

/** Map Read/Manage toggles to a session-level Code Mode access mode. */
export function deriveCodeModeAccessMode(
  readEnabled: boolean,
  manageEnabled: boolean,
): CodeModeAccessMode | undefined {
  if (!readEnabled && !manageEnabled) return undefined;
  if (manageEnabled) return "read_write";
  return "read";
}

function resolveCodeModeAccessMode(
  selectedGroupKeys: string[],
  groupKey: string,
  requested: CodeModeAccessMode | string | undefined | null,
  fallback: CodeModeAccessMode,
): CodeModeAccessMode | undefined {
  if (!selectedGroupKeys.includes(groupKey)) {
    return undefined;
  }
  if (requested === "read") return "read";
  if (requested === "read_write") return "read_write";
  return fallback;
}

export function resolveMapiAccessMode(
  selectedGroupKeys: string[],
  requested: MapiAccessMode | string | undefined | null,
): MapiAccessMode | undefined {
  return resolveCodeModeAccessMode(
    selectedGroupKeys,
    CODE_MODE_MAPI_GROUP_KEY,
    requested,
    "read_write",
  );
}

export function resolveApiAccessMode(
  selectedGroupKeys: string[],
  requested: ApiAccessMode | string | undefined | null,
): ApiAccessMode | undefined {
  return resolveCodeModeAccessMode(selectedGroupKeys, CODE_MODE_API_GROUP_KEY, requested, "read");
}
