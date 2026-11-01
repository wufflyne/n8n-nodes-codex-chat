import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ICredentialDataDecryptedObject,
  IDataObject,
  IHttpRequestOptions,
  INode,
} from "n8n-workflow";
import { assert, CodexError } from "../core/errors.js";

export interface CredentialContext {
  getCredentials(type: string): Promise<ICredentialDataDecryptedObject>;
  getNode(): INode;
  helpers: { httpRequestWithAuthentication: (...args: any[]) => Promise<unknown> };
}
interface Persistence {
  type: string;
  id: string;
  fields: IDataObject;
  committed: boolean;
}
const scopes = new AsyncLocalStorage<Persistence>();
const flights = new Map<string, Promise<unknown>>();
const JWKS = "https://auth.openai.com/.well-known/jwks.json";

/** ID is read only after n8n has authorized and decrypted this node's credential. */
export async function authorizedCredential(ctx: CredentialContext, type: string) {
  const data = await ctx.getCredentials(type);
  const id = ctx.getNode().credentials?.[type]?.id;
  assert(
    typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id),
    "Save and select the credential in this node first.",
  );
  return { id, data };
}

/** Only the package-owned public helper call can enter this unexported ALS scope. */
export async function persistCredential(
  ctx: CredentialContext,
  type: string,
  prepare: (id: string, current: ICredentialDataDecryptedObject) => Promise<IDataObject>,
) {
  const selected = await authorizedCredential(ctx, type);
  const key = `${type}:${selected.id}`;
  const previous = flights.get(key) ?? Promise.resolve();
  const flight = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await authorizedCredential(ctx, type);
      assert(
        current.id === selected.id,
        "The selected credential changed. Run the operation again.",
      );
      const fields = await prepare(current.id, current.data);
      if (Object.entries(fields).every(([k, v]) => current.data[k] === v)) return current;
      const scope: Persistence = { type, id: current.id, fields, committed: false };
      await scopes.run(scope, async () => {
        try {
          await ctx.helpers.httpRequestWithAuthentication.call(ctx, type, {
            url: JWKS,
            method: "GET",
            timeout: 10000,
            returnFullResponse: false,
          });
        } catch {
          // A request can fail after the host has durably committed the credential.
          // The controlled readback below is the persistence oracle.
        }
      });
      const fresh = await authorizedCredential(ctx, type);
      assert(
        scope.committed &&
          fresh.id === current.id &&
          Object.entries(fields).every(([k, v]) => fresh.data[k] === v),
        "The credential update could not be confirmed. No provider sign-in was started. Retry this operation with the same saved credentials.",
      );
      return fresh;
    });
  flights.set(key, flight);
  try {
    return await flight;
  } finally {
    if (flights.get(key) === flight) flights.delete(key);
  }
}

export async function credentialPreAuthentication(type: string): Promise<IDataObject> {
  const scope = scopes.getStore();
  if (!scope || scope.type !== type) return {};
  return { ...scope.fields };
}

/** n8n invokes authenticate only after awaiting its encrypted database update. */
export async function credentialAuthenticate(
  type: string,
  credentials: ICredentialDataDecryptedObject,
  options: IHttpRequestOptions,
) {
  const scope = scopes.getStore();
  if (
    !scope ||
    scope.type !== type ||
    options.url !== JWKS ||
    options.method !== "GET" ||
    options.headers?.Authorization
  )
    throw new CodexError("configuration", "Use this credential only through its Codex Wire node.");
  assert(
    Object.entries(scope.fields).every(([k, v]) => credentials[k] === v),
    "The host credential update was not confirmed.",
  );
  scope.committed = true;
  return options;
}
