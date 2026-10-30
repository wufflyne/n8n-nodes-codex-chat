import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { chmodSync } from "node:fs";

// This module runs only in the explicit repository worker, never on library import.
const config = workerData as {
  filename: string;
  key: Uint8Array;
  globalBytes: number;
  ownerBytes: number;
  idleDays: number;
  absoluteDays: number;
};
const key = Buffer.from(
  hkdfSync("sha256", config.key, "codex-wire-v1", "state-payload", 32),
);
const db = new DatabaseSync(config.filename, {
  enableForeignKeyConstraints: true,
  allowExtension: false,
});
chmodSync(config.filename, 0o600);
db.exec(
  "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA trusted_schema=OFF; CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL); INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version); CREATE TABLE IF NOT EXISTS records(owner TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, created INTEGER NOT NULL, touched INTEGER NOT NULL, expires INTEGER NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(owner,id)); CREATE INDEX IF NOT EXISTS expiry ON records(expires); CREATE TABLE IF NOT EXISTS reservations(owner TEXT NOT NULL,id TEXT NOT NULL,bytes INTEGER NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(owner,id));",
);
const version = db.prepare("SELECT version FROM schema_version").get();
if (version?.version !== 1)
  throw new Error("Unsupported gateway state schema.");
db.exec(
  "CREATE TABLE IF NOT EXISTS capacity_groups(owner TEXT PRIMARY KEY, group_id TEXT NOT NULL); CREATE INDEX IF NOT EXISTS capacity_group ON capacity_groups(group_id)",
);
// Capacity sums read only metadata; avoid scanning encrypted payload pages on every write.
db.exec("CREATE INDEX IF NOT EXISTS records_owner_bytes ON records(owner,bytes)");
// Tightening operator retention also constrains existing history without decrypting its content.
// Operation and ownership records retain their independent security lifetimes.
db.prepare(
  "UPDATE records SET expires=min(expires,touched+?,created+?) WHERE substr(id,1,8)='item_cw_' OR substr(id,1,13)='call:call_cw_'",
).run(config.idleDays * 86400000, config.absoluteDays * 86400000);
db.prepare("DELETE FROM records WHERE expires<=?").run(Date.now());
const aad = (owner: string, id: string) =>
  Buffer.from(JSON.stringify([1, owner, id]));
function seal(owner: string, id: string, value: unknown) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(owner, id));
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
function read(
  owner: string,
  id: string,
  bound?: { bytes: number; revision: number },
) {
  if (bound) {
    const size = db
      .prepare("SELECT bytes,revision FROM records WHERE owner=? AND id=?")
      .get(owner, id);
    if (
      size &&
      (Number(size.bytes) > bound.bytes ||
        Number(size.revision) !== bound.revision)
    )
      throw new Error("conflict");
  }
  const row = db
    .prepare("SELECT * FROM records WHERE owner=? AND id=?")
    .get(owner, id);
  if (!row) return null;
  const bytes = Buffer.from(row.data as Uint8Array),
    decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(aad(owner, id));
  decipher.setAuthTag(bytes.subarray(-16));
  return {
    value: JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(12, -16)),
        decipher.final(),
      ]).toString(),
    ),
    revision: Number(row.revision),
    created: Number(row.created),
    touched: Number(row.touched),
    expires: Number(row.expires),
  };
}
type Write = {
  owner: string;
  id: string;
  value: unknown;
  expires: number;
  remove?: boolean;
};
function capacity(owner: string, extra: number) {
  const sum = (sql: string, ...values: string[]) =>
    Number(db.prepare(sql).get(...values)?.n ?? 0);
  return (
    sum("SELECT coalesce(sum(bytes),0) n FROM records") +
      sum("SELECT coalesce(sum(bytes),0) n FROM reservations") +
      extra <=
      config.globalBytes &&
    sum(
      "SELECT coalesce(sum(bytes),0) n FROM records WHERE owner=? OR owner IN (SELECT owner FROM capacity_groups WHERE group_id=(SELECT group_id FROM capacity_groups WHERE owner=?))",
      owner,
      owner,
    ) +
      sum(
        "SELECT coalesce(sum(bytes),0) n FROM reservations WHERE owner=? OR owner IN (SELECT owner FROM capacity_groups WHERE group_id=(SELECT group_id FROM capacity_groups WHERE owner=?))",
        owner,
        owner,
      ) +
      extra <=
      config.ownerBytes
  );
}
parentPort!.on(
  "message",
  (message: { id: number; action: string; args: any }) => {
    const { action, args } = message;
    try {
      let result: unknown;
      if (action === "group") {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const owner of args.owners as string[]) {
            const previous = db
              .prepare("SELECT group_id FROM capacity_groups WHERE owner=?")
              .get(owner);
            if (previous && previous.group_id !== args.group)
              throw new Error("conflict");
            db.prepare(
              "INSERT OR IGNORE INTO capacity_groups(owner,group_id) VALUES(?,?)",
            ).run(owner, args.group);
          }
          db.exec("COMMIT");
          result = true;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } else if (action === "get")
        result = read(args.owner, args.key, args.bound);
      else if (action === "metadata") {
        if (!Array.isArray(args.keys) || args.keys.length > 256)
          throw new Error("capacity");
        result = args.keys.map((key: string) => {
          const row = db
            .prepare(
              "SELECT bytes,revision FROM records WHERE owner=? AND id=?",
            )
            .get(args.owner, key);
          return row
            ? { key, bytes: Number(row.bytes), revision: Number(row.revision) }
            : null;
        });
      } else if (action === "touch") {
        if (!Array.isArray(args.keys) || args.keys.length > 256)
          throw new Error("capacity");
        const now = Date.now(),
          statement = db.prepare(
            "UPDATE records SET touched=?,expires=min(created+?,?) WHERE owner=? AND id=? AND expires>?",
          );
        for (const key of args.keys)
          statement.run(
            now,
            args.absoluteMs,
            now + args.idleMs,
            args.owner,
            key,
            now,
          );
        result = true;
      } else if (action === "list") {
        const rows = db
          .prepare(
            `SELECT id,bytes FROM records WHERE owner=? AND substr(id,1,?)=? ORDER BY created ${args.descending ? "DESC" : "ASC"},id LIMIT ?`,
          )
          .all(
            args.owner,
            args.prefix.length,
            args.prefix,
            Math.min(args.limit, 256),
          );
        if (
          rows.reduce((sum, row) => sum + Number(row.bytes), 0) >
          2 * 1024 * 1024
        )
          throw new Error("capacity");
        result = rows.map((row) => ({
          key: row.id,
          ...read(args.owner, String(row.id)),
        }));
      } else if (action === "transaction") {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const c of args.checks) {
            const row = db
              .prepare("SELECT revision FROM records WHERE owner=? AND id=?")
              .get(c.owner, c.id);
            if ((row ? Number(row.revision) : null) !== c.revision)
              throw new Error("conflict");
          }
          if (args.release)
            db.prepare("DELETE FROM reservations WHERE owner=? AND id=?").run(
              args.release.owner,
              args.release.id,
            );
          const now = Date.now();
          for (const w of args.writes as Write[]) {
            if (w.remove) {
              db.prepare("DELETE FROM records WHERE owner=? AND id=?").run(
                w.owner,
                w.id,
              );
              continue;
            }
            const payload = seal(w.owner, w.id, w.value),
              previous = db
                .prepare("SELECT bytes FROM records WHERE owner=? AND id=?")
                .get(w.owner, w.id);
            if (
              !capacity(w.owner, payload.length - Number(previous?.bytes ?? 0))
            )
              throw new Error("capacity");
            db.prepare(
              "INSERT INTO records VALUES(?,?,1,?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET revision=revision+1,touched=excluded.touched,expires=excluded.expires,bytes=excluded.bytes,data=excluded.data",
            ).run(w.owner, w.id, now, now, w.expires, payload.length, payload);
          }
          db.exec("COMMIT");
          result = true;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } else if (action === "reserve") {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (!capacity(args.owner, args.bytes)) throw new Error("capacity");
          db.prepare("INSERT INTO reservations VALUES(?,?,?,?)").run(
            args.owner,
            args.id,
            args.bytes,
            args.expires,
          );
          db.exec("COMMIT");
          result = true;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } else if (action === "release") {
        db.prepare("DELETE FROM reservations WHERE owner=? AND id=?").run(
          args.owner,
          args.id,
        );
        result = true;
      } else if (action === "purgeConnection") {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("DELETE FROM records WHERE owner=?").run(
            args.historyOwner,
          );
          for (const row of db
            .prepare("SELECT id FROM records WHERE owner=?")
            .iterate(args.operationsOwner)) {
            const entry = read(args.operationsOwner, String(row.id));
            if (entry?.value.response) {
              delete entry.value.response;
              entry.value.stored = false;
              const payload = seal(
                args.operationsOwner,
                String(row.id),
                entry.value,
              );
              db.prepare(
                "UPDATE records SET data=?,bytes=?,revision=revision+1 WHERE owner=? AND id=?",
              ).run(
                payload,
                payload.length,
                args.operationsOwner,
                String(row.id),
              );
            }
          }
          db.exec("COMMIT");
          result = true;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } else if (action === "cleanup") {
        db.prepare("DELETE FROM records WHERE expires<=?").run(args.now);
        db.prepare("DELETE FROM reservations WHERE expires<=?").run(args.now);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        result = true;
      } else if (action === "close") {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.close();
        result = true;
      } else throw new Error("invalid");
      parentPort!.postMessage({ id: message.id, result });
      if (action === "close") parentPort!.close();
    } catch (error) {
      const code =
        error instanceof Error &&
        ["conflict", "capacity"].includes(error.message)
          ? error.message
          : "storage";
      parentPort!.postMessage({ id: message.id, error: code });
    }
  },
);
parentPort!.postMessage({ ready: true });
