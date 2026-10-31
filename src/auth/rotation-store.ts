import { createHmac, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { CodexError, assert } from "../core/errors.js";
import { delay } from "../core/http.js";
import type { Profile, TokenSet } from "../core/types.js";
import { atomicWrite, readPrivateFile, PROFILE_MAX_BYTES, type ProfileStore } from "./store.js";
import { journalChunks, readJournal, writeJournal } from "./journal-io.js";

export const ROTATION_LIMITS = Object.freeze({ records: 65536, captures: 128, bytes: 64 * 1024 * 1024, responseBytes: 256 * 1024 });
type Epoch = { id: string; generation: number; state: "ready" | "dispatching" | "terminal" | "blocked" };
type Claim = { owner: string; identity: string; epochs: Epoch[] };
export type SuccessCapture = { kind: "http"; bytes: string } | { kind: "tokens"; tokens: TokenSet };
type Receipt = { id: string; digest: string; epoch: string; before: Profile; bootstrap?: true; previous?: Profile; capture?: SuccessCapture; replacement?: Profile; nextEpoch?: string };
type Journal = { version: 2; migrated: true; claims: Record<string, Claim>; receipts: Record<string, Receipt>; registrations: Record<string, Profile> };
const failure = () => new CodexError("reconnect", "This rotating token is already owned, uncertain, or previously used. Use a fresh independent login; do not restore an older token snapshot.");

/** Store-wide safety state. Lock order is profile then registry; no network work holds the registry lock. */
export class RotationStore {
  private initialized?: Promise<void>;
  private readonly readyCache = new Map<string, { stamp: string; generation: number; digest: string; identity: string }>();
  private readonly key: Buffer;
  private readonly indexKey: Buffer;
  private readonly filename: string;
  private readonly marker: string;
  constructor(private readonly store: ProfileStore, key: Buffer) {
    this.key = createHmac("sha256", key).update("codex-wire/rotation/encryption/v2").digest();
    this.indexKey = createHmac("sha256", key).update("codex-wire/rotation/index/v2").digest();
    this.legacyKey = Buffer.from(key);
    this.filename = path.join(store.directory, ".rotation-v2.json.enc");
    this.marker = path.join(store.directory, ".rotation-v2.initialized");
  }
  private readonly legacyKey: Buffer;
  private digest(token: string) { return createHmac("sha256", this.indexKey).update(token).digest("hex"); }
  private identity(profile: Profile) {
    return createHmac("sha256", this.indexKey).update(JSON.stringify([profile.issuer, profile.subject, profile.accountId, profile.clientId])).digest("hex");
  }
  private async legacyUsed(token: string) {
    const digest = createHmac("sha256", this.legacyKey).update(token).digest("hex");
    try { await lstat(path.join(this.store.directory, `.import-${digest}.used`)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  private async locked<T>(action: (journal: Journal) => Promise<T>, write = true): Promise<T> {
    assert(!this.store.readOnly, "This profile store is open for local read-only diagnostics.");
    await this.store.ready();
    const lock = path.join(this.store.directory, ".rotation-v2.lock"), deadline = Date.now() + 30000;
    while (true) {
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline)
          throw new CodexError("storage", "The token registry is locked or unavailable. Stop all store users before inspecting abandoned locks; preserve any pending recovery material.");
        await delay(25);
      }
    }
    try {
      const journal = await this.load();
      const result = await action(journal);
      if (write) await this.save(journal);
      return result;
    } catch (error) {
      if (error instanceof CodexError) throw error;
      throw new CodexError("storage", "The token registry could not be read or committed safely. Preserve the store and recover it offline before renewal.");
    } finally { await rmdir(lock); }
  }
  private async load(): Promise<Journal> {
    let initialized = false;
    try {
      await lstat(this.marker);
      assert(await readPrivateFile(this.marker, 128) === "codex-wire/token-journal/v2\n", "The token journal initialization marker is invalid. Preserve the store for offline recovery.");
      initialized = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await lstat(this.filename); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      assert(!initialized, "The established token journal is missing. Preserve the current store; never reconstruct ownership from an older profile snapshot.");
      // No profile locks are acquired here. The exclusive owner fences all legacy writers.
      const journal: Journal = { version: 2, migrated: true, claims: {}, receipts: {}, registrations: {} };
      for (const name of (await readdir(this.store.directory)).sort()) {
        if (!/^[a-f0-9-]{36}\.json\.enc$/.test(name)) continue;
        const profile = await this.store.readId(name.slice(0, -9)), token = profile.tokens.refreshToken;
        if (!token) continue;
        const digest = this.digest(token), old = journal.claims[digest];
        if (old) {
          old.owner = "conflict";
          for (const epoch of old.epochs) epoch.state = "blocked";
          continue;
        }
        journal.claims[digest] = { owner: profile.id, identity: this.identity(profile), epochs: [{ id: randomUUID(), generation: profile.generation, state: profile.state === "ready" && !await this.legacyUsed(token) ? "ready" : "blocked" }] };
      }
      // A single durable atomic migration is resumable: no provider operation is possible before it.
      await this.save(journal);
      await atomicWrite(this.marker, "codex-wire/token-journal/v2\n");
      return journal;
    }
    const journal = await readJournal(this.filename, this.key, ROTATION_LIMITS.bytes) as Journal;
    assert(journal.version === 2 && journal.migrated === true && journal.claims && journal.receipts && journal.registrations, "The token journal is invalid.");
    this.bounded(journal);
    if (!initialized) await atomicWrite(this.marker, "codex-wire/token-journal/v2\n");
    return journal;
  }
  private bounded(journal: Journal) {
    assert(journal && typeof journal === "object" && !Array.isArray(journal) && Object.keys(journal).length === 5 && Object.keys(journal).every((key) => ["version", "migrated", "claims", "receipts", "registrations"].includes(key)) && [journal.claims, journal.receipts, journal.registrations].every((value) => value && typeof value === "object" && !Array.isArray(value)), "The token journal structure is invalid.");
    let records = 0;
    for (const [digest, claim] of Object.entries(journal.claims)) {
      assert(/^[a-f0-9]{64}$/.test(digest) && claim && typeof claim.owner === "string" && /^[a-f0-9]{64}$/.test(claim.identity) && Array.isArray(claim.epochs) && claim.epochs.length > 0, "The token ownership journal is invalid.");
      records += 1 + claim.epochs.length;
      for (const epoch of claim.epochs)
        assert(typeof epoch.id === "string" && Number.isSafeInteger(epoch.generation) && epoch.generation > 0 && ["ready", "dispatching", "terminal", "blocked"].includes(epoch.state), "The renewal epoch journal is invalid.");
      assert(claim.epochs.filter((e) => e.state === "ready" || e.state === "dispatching").length <= 1, "The token journal has conflicting epochs.");
    }
    const receipts = Object.values(journal.receipts);
    const successorReservation = receipts.filter((r) => !r.replacement).length * 2;
    assert(records + successorReservation <= ROTATION_LIMITS.records && receipts.length <= ROTATION_LIMITS.captures, "The token safety journal is full. No records may be evicted to reuse old material; move to a fresh managed store with independent logins.");
    // Reserve the entire maximum success payload before dispatch, including base64 representation.
    const reserved = receipts.reduce((n, r) => n + (r.replacement ? 0 : PROFILE_MAX_BYTES + 4096 + (r.capture ? 0 : Math.ceil(ROTATION_LIMITS.responseBytes * 4 / 3) + 1024)), 0);
    let bytes = reserved;
    for (const chunk of journalChunks(journal)) {
      bytes += Buffer.byteLength(chunk);
      assert(bytes <= ROTATION_LIMITS.bytes, "The token safety journal payload limit has been reached. No new renewal is authorized; preserve any pending recovery material.");
    }
  }
  private async save(journal: Journal) {
    this.bounded(journal);
    await writeJournal(this.filename, this.key, journalChunks(journal));
    this.readyCache.clear();
  }
  async initialize() {
    this.initialized ??= this.locked(async () => undefined, false);
    try { await this.initialized; } catch (error) { this.initialized = undefined; throw error; }
  }
  private async stamp() {
    const stat = await lstat(this.filename, { bigint: true });
    assert(stat.isFile() && (stat.mode & 0o077n) === 0n, "The token journal must be a private regular file.");
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }
  private readyClaim(journal: Journal, profile: Profile): Claim | undefined {
    const token = profile.tokens.refreshToken;
    if (!token) return;
    const claim = journal.claims[this.digest(token)], epoch = claim?.epochs.at(-1);
    if (!claim || claim.owner !== profile.id || claim.identity !== this.identity(profile) || epoch?.state !== "ready" || epoch.generation !== profile.generation || journal.registrations[profile.id]) throw failure();
    return claim;
  }
  async assertReady(profile: Profile) {
    await this.initialize();
    if (!profile.tokens.refreshToken) return;
    const digest = this.digest(profile.tokens.refreshToken), identity = this.identity(profile);
    const stamp = await this.stamp(), cached = this.readyCache.get(profile.id);
    if (cached?.stamp === stamp && cached.generation === profile.generation && cached.digest === digest && cached.identity === identity) return;
    await this.locked(async (j) => {
      this.readyClaim(j, profile);
      if (this.readyCache.size >= 128) this.readyCache.delete(this.readyCache.keys().next().value!);
      this.readyCache.set(profile.id, { stamp: await this.stamp(), generation: profile.generation, digest, identity });
    }, false);
    // This cache authorizes only the current access session. Every dispatch and mutation reloads under lock.
  }
  /** The ownership reservation precedes the profile write; a failed registration remains fenced. */
  async register(profile: Profile, previous?: Profile) {
    profile = structuredClone(profile);
    previous = previous && structuredClone(previous);
    await this.locked(async (j) => {
      this.noPendingPromotion(j, profile.id);
      const token = profile.tokens.refreshToken;
      if (token) {
        const digest = this.digest(token), claim = j.claims[digest];
        if (claim) {
          if (!previous || previous.tokens.refreshToken !== token) throw failure();
          this.readyClaim(j, previous);
        } else {
          if (await this.legacyUsed(token)) throw failure();
          j.claims[digest] = { owner: profile.id, identity: this.identity(profile), epochs: [{ id: randomUUID(), generation: profile.generation, state: "blocked" }] };
        }
      }
      assert(!j.registrations[profile.id], "A prior account registration must be recovered before reconnecting.");
      j.registrations[profile.id] = profile;
    });
    await this.finishRegistration(profile.id);
  }
  private async finishRegistration(id: string) {
    const profile = await this.locked(async (j) => j.registrations[id], false);
    if (!profile) return;
    await this.store.write(profile);
    await this.locked(async (j) => {
      assert(JSON.stringify(j.registrations[id]) === JSON.stringify(profile), "Account registration changed during recovery.");
      if (profile.tokens.refreshToken) {
        const claim = j.claims[this.digest(profile.tokens.refreshToken)];
        assert(claim?.owner === id && claim.identity === this.identity(profile), "Account registration ownership conflicts.");
        const epoch = claim.epochs.at(-1)!;
        epoch.generation = profile.generation; epoch.state = profile.state === "ready" ? "ready" : "blocked";
      }
      delete j.registrations[id];
      this.retirePriorFamilies(j, profile);
    });
  }
  private noPendingPromotion(journal: Journal, id: string) {
    assert(!Object.values(journal.receipts).some((r) => r.before.id === id && r.replacement), "A verified successful renewal must be recovered before reconnecting this profile.");
  }
  private retirePriorFamilies(journal: Journal, profile: Profile) {
    const current = profile.tokens.refreshToken ? this.digest(profile.tokens.refreshToken) : undefined;
    for (const [digest, claim] of Object.entries(journal.claims)) {
      if (claim.owner !== profile.id || digest === current) continue;
      for (const epoch of claim.epochs) if (epoch.state === "ready") epoch.state = "terminal";
    }
  }
  async begin(profile: Profile): Promise<string> {
    profile = structuredClone(profile);
    const id = randomUUID();
    await this.locked(async (j) => {
      const claim = this.readyClaim(j, profile); assert(claim && profile.state === "ready", "The renewable profile is not ready.");
      const epoch = claim.epochs.at(-1)!;
      epoch.state = "dispatching";
      j.receipts[id] = { id, digest: this.digest(profile.tokens.refreshToken!), epoch: epoch.id, before: profile };
    });
    await this.store.write({ ...profile, state: "refresh_uncertain" });
    return id;
  }
  /** Bootstrap owns candidate material without replacing an unrelated working token family. */
  async beginBootstrap(candidate: Profile, previous?: Profile): Promise<string> {
    candidate = structuredClone(candidate);
    previous = previous && structuredClone(previous);
    const id = randomUUID(), token = candidate.tokens.refreshToken;
    assert(token, "Bootstrap renewal requires renewable material.");
    await this.locked(async (j) => {
      this.noPendingPromotion(j, candidate.id);
      const digest = this.digest(token);
      let claim = j.claims[digest];
      if (claim) {
        if (!previous || previous.tokens.refreshToken !== token) throw failure();
        this.readyClaim(j, previous);
      } else {
        if (await this.legacyUsed(token)) throw failure();
        claim = { owner: candidate.id, identity: this.identity(candidate), epochs: [{ id: randomUUID(), generation: candidate.generation, state: "ready" }] };
        j.claims[digest] = claim;
      }
      const epoch = claim.epochs.at(-1)!;
      epoch.state = "dispatching";
      // This is the durable profile intent for an initial import; its protected binding was delivered first.
      j.receipts[id] = { id, digest, epoch: epoch.id, before: candidate, bootstrap: true, ...(previous ? { previous } : {}) };
    });
    if (previous?.tokens.refreshToken === token)
      await this.store.write({ ...previous, state: "refresh_uncertain" });
    return id;
  }
  async capture(id: string, capture: SuccessCapture) {
    capture = structuredClone(capture);
    const bytes = capture.kind === "http" ? Buffer.from(capture.bytes, "base64").length : Buffer.byteLength(JSON.stringify(capture.tokens));
    assert(bytes <= ROTATION_LIMITS.responseBytes, "The successful renewal response exceeds its recovery limit.");
    await this.locked(async (j) => {
      const receipt = j.receipts[id]; assert(receipt && !receipt.capture, "The renewal capture is missing or already exists.");
      receipt.capture = capture;
    });
  }
  async captured(id: string) { return this.locked(async (j) => Boolean(j.receipts[id]?.capture), false); }
  async verifyReceipt(id: string, replacement: Profile) {
    replacement = structuredClone(replacement);
    await this.locked(async (j) => {
      const receipt = j.receipts[id];
      assert(receipt?.capture && replacement.id === receipt.before.id && replacement.generation === receipt.before.generation + (receipt.bootstrap ? 0 : 1) && replacement.state === "ready" && this.identity(replacement) === this.identity(receipt.before), "The renewal receipt cannot be promoted to this profile.");
      const digest = replacement.tokens.refreshToken ? this.digest(replacement.tokens.refreshToken) : undefined;
      // Omitted refresh material must be preserved by the provider adapter.
      assert(digest, "The successful renewal did not preserve renewable material.");
      if (digest !== receipt.digest && j.claims[digest]) throw failure();
      if (receipt.replacement) {
        assert(JSON.stringify(receipt.replacement) === JSON.stringify(replacement), "The verified renewal receipt conflicts.");
        return;
      }
      receipt.replacement = replacement; receipt.nextEpoch = randomUUID();
      const old = j.claims[receipt.digest]!;
      assert(old.owner === replacement.id && old.epochs.at(-1)?.id === receipt.epoch && old.epochs.at(-1)?.state === "dispatching", "The renewal epoch changed before verification.");
      // Reserve a successor without authorizing it. The prior epoch stays dispatching until the profile is durable.
      if (digest !== receipt.digest) j.claims[digest] = { owner: replacement.id, identity: this.identity(replacement), epochs: [{ id: receipt.nextEpoch, generation: replacement.generation, state: "blocked" }] };
      // Account for the future same-digest epoch before writing any profile.
      if (digest === receipt.digest) old.epochs.push({ id: receipt.nextEpoch, generation: replacement.generation, state: "blocked" });
    });
  }
  async promote(id: string): Promise<Profile> {
    const receipt = await this.locked(async (j) => structuredClone(j.receipts[id]), false);
    assert(receipt?.replacement && receipt.nextEpoch, "A verified successful renewal receipt is required for offline promotion.");
    const replacement = receipt.replacement;
    const current = await this.store.exists(replacement.id) ? await this.store.readId(replacement.id) : undefined;
    const expected = receipt.bootstrap ? receipt.previous : receipt.before;
    const withoutState = (profile: Profile) => ({ ...profile, state: "ready" });
    assert((!current && !expected) || (current && JSON.stringify(current) === JSON.stringify(replacement)) || (current && expected && JSON.stringify(withoutState(current)) === JSON.stringify(withoutState(expected))), "The profile changed after renewal. Preserve the captured response for offline recovery.");
    await this.store.write(replacement);
    await this.locked(async (j) => {
      const pending = j.receipts[id]; assert(pending?.nextEpoch === receipt.nextEpoch, "The renewal receipt changed during promotion.");
      const old = j.claims[receipt.digest]!.epochs.find((e) => e.id === receipt.epoch);
      assert(old?.state === "dispatching", "The previous renewal epoch is not dispatching."); old.state = "terminal";
      const successor = j.claims[this.digest(replacement.tokens.refreshToken!)]!;
      assert(successor.owner === replacement.id, "The successor token has a different owner.");
      const epoch = successor.epochs.find((e) => e.id === receipt.nextEpoch);
      assert(epoch?.state === "blocked", "The successor epoch was not reserved."); epoch.state = "ready";
      this.retirePriorFamilies(j, replacement);
      // Removal happens in the same synced commit that authorizes the successor, after the synced profile.
      delete j.receipts[id];
    });
    return replacement;
  }
  async recoverCommitted(id: string) {
    await this.finishRegistration(id);
    const receipts = await this.locked(async (j) => Object.values(j.receipts).filter((r) => r.before.id === id && r.replacement).map((r) => r.id), false);
    for (const receipt of receipts) await this.promote(receipt);
  }
  async recoveryReceipt(id: string) {
    return this.locked(async (j) => {
      const receipts = Object.values(j.receipts).filter((r) => r.before.id === id);
      assert(receipts.length === 1 && receipts[0]!.capture, "There is no single captured successful renewal to recover. A lost response or failed capture cannot be reconstructed; use an independent login.");
      return structuredClone(receipts[0]!);
    }, false);
  }
  async hasReceipt(id: string) { return this.locked(async (j) => Object.values(j.receipts).some((r) => r.before.id === id), false); }
  async recoveryBindingProfile(id: string) {
    return this.locked(async (j) => {
      const profile = j.registrations[id] ?? Object.values(j.receipts).find((r) => r.before.id === id)?.before;
      assert(profile, "No durable registration or renewal intent exists for this binding.");
      return structuredClone(profile);
    }, false);
  }
}
