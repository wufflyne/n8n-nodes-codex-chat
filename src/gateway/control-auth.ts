import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { open, unlink, mkdir } from "node:fs/promises";
import type { StateRepository } from "./state/repository.js";
import { WireError } from "./errors.js";
import { readPrivateFile } from "../auth/store.js";
import path from "node:path";
const derive = promisify(scrypt);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
interface Administrator {
  salt: string;
  passwordHash: string;
}
interface BrowserSession {
  csrf: string;
  expires: number;
}
export class ConsoleAuthentication {
  readonly owner: string;
  private failures = new Map<string, { count: number; until: number }>();
  constructor(
    private readonly state: StateRepository,
    private readonly bootstrapFile: string,
  ) {
    this.owner = state.scope("console");
  }
  async initialize() {
    if (
      (await this.state.get(this.owner, "administrator")) ||
      (await this.state.get(this.owner, "bootstrap"))
    )
      return;
    let token = randomBytes(32).toString("base64url");
    await mkdir(path.dirname(this.bootstrapFile), { recursive: true, mode: 0o700 });
    try {
      const file = await open(this.bootstrapFile, "wx", 0o600);
      try {
        await file.writeFile(token + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      const directory = await open(path.dirname(this.bootstrapFile), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      token = (await readPrivateFile(this.bootstrapFile, 128)).trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(token))
        throw new WireError(
          422,
          "bootstrap_recovery",
          "The interrupted bootstrap file is not valid.",
        );
    }
    await this.state.transaction(
      [{ owner: this.owner, id: "bootstrap", revision: null }],
      [
        {
          owner: this.owner,
          id: "bootstrap",
          value: { hash: hash(token) },
          expires: Number.MAX_SAFE_INTEGER,
        },
      ],
    );
  }
  async status() {
    return { initialized: Boolean(await this.state.get(this.owner, "administrator")) };
  }
  private throttle(actor: string) {
    if (this.failures.size > 1024) this.failures.clear();
    const f = this.failures.get(actor);
    if (f && f.until > Date.now() && f.count >= 8)
      throw new WireError(
        429,
        "login_rate_limit",
        "Too many login attempts. Wait before trying again.",
      );
    if (!f || f.until <= Date.now())
      this.failures.set(actor, { count: 1, until: Date.now() + 60000 });
    else f.count++;
  }
  async bootstrap(token: string, passphrase: string, actor: string) {
    this.throttle(actor);
    const entry = await this.state.get<{ hash: string }>(this.owner, "bootstrap");
    if (
      !entry ||
      (await this.state.get(this.owner, "administrator")) ||
      typeof token !== "string" ||
      !timingSafeEqual(Buffer.from(entry.value.hash, "hex"), Buffer.from(hash(token), "hex"))
    )
      throw new WireError(
        401,
        "invalid_bootstrap",
        "The bootstrap token is invalid or has already been used.",
      );
    if (typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 1024)
      throw new WireError(
        400,
        "passphrase_length",
        "Use an administrator passphrase with 12–1024 characters.",
        "passphrase",
      );
    const salt = randomBytes(16).toString("hex"),
      passwordHash = ((await derive(passphrase, salt, 64)) as Buffer).toString("hex");
    await this.state.transaction(
      [{ owner: this.owner, id: "administrator", revision: null }],
      [
        {
          owner: this.owner,
          id: "administrator",
          value: { salt, passwordHash },
          expires: Number.MAX_SAFE_INTEGER,
        },
        { owner: this.owner, id: "bootstrap", remove: true },
      ],
    );
    await unlink(this.bootstrapFile);
    return this.newSession();
  }
  async login(passphrase: string, actor: string) {
    this.throttle(actor);
    const entry = await this.state.get<Administrator>(this.owner, "administrator");
    if (!entry || typeof passphrase !== "string" || passphrase.length > 1024)
      throw new WireError(401, "invalid_login", "The administrator passphrase is invalid.");
    const actual = (await derive(passphrase, entry.value.salt, 64)) as Buffer;
    if (!timingSafeEqual(actual, Buffer.from(entry.value.passwordHash, "hex")))
      throw new WireError(401, "invalid_login", "The administrator passphrase is invalid.");
    this.failures.delete(actor);
    return this.newSession();
  }
  private async newSession() {
    const token = randomBytes(32).toString("base64url"),
      csrf = randomBytes(32).toString("base64url"),
      expires = Date.now() + 8 * 3600000;
    await this.state.transaction(
      [],
      [{ owner: this.owner, id: `session:${hash(token)}`, value: { csrf, expires }, expires }],
    );
    return { token, csrf, expires };
  }
  async session(token: string | undefined, csrf?: string, mutating = false) {
    const session = token
      ? await this.state.get<BrowserSession>(this.owner, `session:${hash(token)}`)
      : null;
    if (!session || session.value.expires <= Date.now())
      throw new WireError(401, "login_required", "Sign in to the Codex Wire console.");
    if (mutating && csrf !== session.value.csrf)
      throw new WireError(403, "csrf", "The console request token is invalid.");
    return session.value;
  }
  async logout(token: string) {
    await this.state.transaction(
      [],
      [{ owner: this.owner, id: `session:${hash(token)}`, remove: true }],
    );
  }
}
