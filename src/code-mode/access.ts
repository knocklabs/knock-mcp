import type { MapiAccessMode } from "../types";
import { CODE_MODE_MAPI_GROUP_KEY } from "../tool-groups";

/** Whether Management API code mode is enabled from Read/Manage consent toggles. */
export function isMapiCodeModeEnabled(readEnabled: boolean, manageEnabled: boolean): boolean {
  return readEnabled || manageEnabled;
}

/** Map Read/Manage toggles to host-enforced HTTP access for execute_mapi. */
export function deriveMapiAccessMode(
  readEnabled: boolean,
  manageEnabled: boolean,
): MapiAccessMode | undefined {
  if (!isMapiCodeModeEnabled(readEnabled, manageEnabled)) return undefined;
  if (manageEnabled) return "read_write";
  return "read";
}

export function resolveMapiAccessMode(
  selectedGroupKeys: string[],
  requested: MapiAccessMode | string | undefined | null,
): MapiAccessMode | undefined {
  if (!selectedGroupKeys.includes(CODE_MODE_MAPI_GROUP_KEY)) {
    return undefined;
  }
  if (requested === "read") return "read";
  return "read_write";
}
