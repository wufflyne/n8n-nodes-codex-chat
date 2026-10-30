import type { Binding } from "../core/types.js";

const capabilities = new WeakSet<object>();
export interface ProfileAccess {
  readonly profileId: string;
  readonly authority: "native" | "inference" | "administrator";
}
export type ProfileBinding = Binding | ProfileAccess;
/** Server composition alone issues these after verifying the corresponding actor. Never serialized. */
export function verifiedAccess(
  profileId: string,
  authority: ProfileAccess["authority"],
): ProfileAccess {
  const capability = Object.freeze({ profileId, authority });
  capabilities.add(capability);
  return capability;
}
export function isProfileAccess(value: ProfileBinding): value is ProfileAccess {
  return capabilities.has(value);
}
