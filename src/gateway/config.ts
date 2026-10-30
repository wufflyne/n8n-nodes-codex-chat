import { readPrivateFile } from "../auth/store.js";
import path from "node:path";

export interface GatewayConfig {
  version: 1;
  inference: {
    host: string;
    port: number;
    privateHttp: boolean;
    origin: string;
  };
  admin: {
    host: string;
    port: number;
    origin: string;
    allowLoopbackHttp?: boolean;
    bootstrapFile: string;
  };
  storeDirectory: string;
  masterKeyFile: string;
  stateFile: string;
  contextIntegrationQualified?: boolean;
  refreshEnabled?: boolean;
  retention?: Partial<GatewayTuning["retention"]>;
  admission?: Partial<GatewayTuning["admission"]>;
  stateLimits?: Partial<{ globalBytes: number; connectionBytes: number }>;
}
export interface GatewayTuning {
  retention: { idleDays: number; absoluteDays: number };
  admission: {
    active: number;
    account: number;
    queued: number;
    waitMs: number;
  };
  state: { globalBytes: number; ownerBytes: number };
}
/** Operator settings may reduce the qualified safety ceilings, never relax them. */
export function gatewayTuning(
  config: Pick<GatewayConfig, "retention" | "admission" | "stateLimits"> = {},
): GatewayTuning {
  const bounded = <T extends Record<string, number>>(
    value: unknown,
    defaults: T,
    minimums: T,
  ): T => {
    if (
      value !== undefined &&
      (!value || typeof value !== "object" || Array.isArray(value))
    )
      throw new Error("Gateway limits must be objects.");
    const supplied = (value ?? {}) as Record<string, unknown>;
    if (Object.keys(supplied).some((key) => !Object.hasOwn(defaults, key)))
      throw new Error("Unknown gateway limit.");
    const result = { ...defaults };
    for (const key of Object.keys(defaults) as Array<keyof T>) {
      const number = Object.hasOwn(supplied, key)
        ? supplied[key as string]
        : defaults[key];
      if (
        !Number.isSafeInteger(number) ||
        (number as number) < minimums[key]! ||
        (number as number) > defaults[key]!
      )
        throw new Error(
          "Gateway limits must be integers within the documented safety bounds.",
        );
      result[key] = number as T[keyof T];
    }
    return result;
  };
  const retention = bounded(
    config.retention,
    { idleDays: 30, absoluteDays: 90 },
    { idleDays: 2, absoluteDays: 2 },
  );
  const admission = bounded(
    config.admission,
    { active: 8, account: 2, queued: 64, waitMs: 10000 },
    { active: 1, account: 1, queued: 0, waitMs: 100 },
  );
  const state = bounded(
    config.stateLimits,
    { globalBytes: 1024 ** 3, connectionBytes: 256 * 1024 ** 2 },
    { globalBytes: 32 * 1024 ** 2, connectionBytes: 32 * 1024 ** 2 },
  );
  if (
    retention.idleDays > retention.absoluteDays ||
    admission.account > admission.active ||
    state.connectionBytes > state.globalBytes
  )
    throw new Error(
      "Gateway limits conflict: idle/account/connection must not exceed absolute/active/global.",
    );
  return {
    retention,
    admission,
    state: {
      globalBytes: state.globalBytes,
      ownerBytes: state.connectionBytes,
    },
  };
}
export async function loadConfig(filename: string): Promise<GatewayConfig> {
  const c = JSON.parse(await readPrivateFile(filename, 32768)) as GatewayConfig;
  if (
    c.version !== 1 ||
    !c.inference ||
    !c.admin ||
    Object.keys(c).some(
      (k) =>
        ![
          "version",
          "inference",
          "admin",
          "storeDirectory",
          "masterKeyFile",
          "stateFile",
          "contextIntegrationQualified",
          "refreshEnabled",
          "retention",
          "admission",
          "stateLimits",
        ].includes(k),
    )
  )
    throw new Error("Invalid gateway configuration.");
  gatewayTuning(c);
  for (const key of ["refreshEnabled", "contextIntegrationQualified"] as const)
    if (c[key] !== undefined && typeof c[key] !== "boolean")
      throw new Error("Gateway switches must be boolean.");
  for (const v of [
    c.storeDirectory,
    c.masterKeyFile,
    c.stateFile,
    c.admin.bootstrapFile,
  ])
    if (typeof v !== "string" || !path.isAbsolute(v))
      throw new Error("Gateway storage and key paths must be absolute.");
  for (const listener of [c.inference, c.admin])
    if (
      typeof listener.host !== "string" ||
      !Number.isInteger(listener.port) ||
      listener.port < 1 ||
      listener.port > 65535
    )
      throw new Error("Invalid gateway listener.");
  if (c.inference.port === c.admin.port && c.inference.host === c.admin.host)
    throw new Error("Inference and administration require separate listeners.");
  const origin = new URL(c.admin.origin),
    loopback = ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname);
  if (
    origin.origin !== c.admin.origin ||
    origin.username ||
    origin.password ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        loopback &&
        c.admin.allowLoopbackHttp === true
      ))
  )
    throw new Error(
      "The console requires an exact HTTPS origin, or an explicitly enabled loopback HTTP origin.",
    );
  if (!c.inference.privateHttp)
    throw new Error(
      "The private HTTP inference listener requires explicit privateHttp acknowledgement and an operator-controlled secure ingress for external access.",
    );
  const inferenceOrigin = new URL(c.inference.origin);
  if (
    inferenceOrigin.origin !== c.inference.origin ||
    !["https:", "http:"].includes(inferenceOrigin.protocol) ||
    inferenceOrigin.username ||
    inferenceOrigin.password
  )
    throw new Error("Configure the exact inference origin used by n8n.");
  if (c.masterKeyFile.startsWith(c.storeDirectory + path.sep))
    throw new Error("Keep the master key outside the profile store.");
  return c;
}
