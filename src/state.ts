import fs from "node:fs/promises"
import path from "node:path"
import { openSQLiteDatabase, type SQLiteDatabase } from "./sqlite.js"

export type AnyRecord = Record<string, unknown>

export type Checkpoint = {
  providerID: string
  responseID: string
  afterMessageID: string
  afterCreatedAt: number
  createdAt: number
  items: AnyRecord[]
}

type CheckpointRow = {
  provider_id: string
  session_id: string
  response_id: string
  after_message_id: string
  after_created_at: number
  created_at: number
  items_json: string
}

type ControlMessageRow = {
  provider_id: string
  session_id: string
  message_id: string
  created_at: number
  content_text: string
}

export type ControlMessage = {
  providerID: string
  sessionID: string
  messageID: string
  createdAt: number
  contentText: string
}

const schemaVersion = 2
const dayMs = 24 * 60 * 60 * 1000

function asRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : undefined
}

export function compactedItemsFrom(value: unknown): AnyRecord[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items: AnyRecord[] = []
  for (const valueItem of value) {
    const record = asRecord(valueItem)
    if (!record) continue

    let item = record
    if (item.type === "compaction_summary") {
      if (typeof item.encrypted_content !== "string") return undefined
      item = { ...item, type: "compaction" }
    }
    if (item.role === "developer" || item.role === "system") continue
    items.push(item)
  }

  const compactions = items.filter((item) => item.type === "compaction")
  if (compactions.length !== 1 || typeof compactions[0].encrypted_content !== "string") return undefined
  return items
}

function checkpointFromRow(row: CheckpointRow): Checkpoint | undefined {
  const items = compactedItemsFrom(JSON.parse(row.items_json))
  if (!items) return undefined
  return {
    providerID: row.provider_id,
    responseID: row.response_id,
    afterMessageID: row.after_message_id,
    afterCreatedAt: row.after_created_at,
    createdAt: row.created_at,
    items,
  }
}

export class CheckpointStore {
  private constructor(private readonly db: SQLiteDatabase) {}

  static async open(file: string) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const db = openSQLiteDatabase(file)
    configureFileDatabase(db)
    const store = new CheckpointStore(db)
    store.migrate()
    return store
  }

  static openMemory() {
    const store = new CheckpointStore(openSQLiteDatabase(":memory:"))
    store.migrate()
    return store
  }

  close() {
    this.db.close()
  }

  loadAll() {
    const rows = this.db
      .query<CheckpointRow>(
        `select provider_id, session_id, response_id, after_message_id, after_created_at, created_at, items_json
         from checkpoints
         order by provider_id, session_id, after_created_at, created_at`,
      )
      .all()
    const result: Array<{ sessionID: string; checkpoint: Checkpoint }> = []

    for (const row of rows) {
      try {
        const checkpoint = checkpointFromRow(row)
        if (!checkpoint) continue
        result.push({ sessionID: row.session_id, checkpoint })
      } catch {
        // Malformed rows are ignored; future saves overwrite by response id.
      }
    }

    return result
  }

  upsert(sessionID: string, checkpoint: Checkpoint) {
    this.db
      .query(
        `insert into checkpoints (
           provider_id, session_id, response_id, after_message_id, after_created_at, created_at, items_json
         ) values (?, ?, ?, ?, ?, ?, ?)
         on conflict(provider_id, session_id, response_id) do update set
           after_message_id = excluded.after_message_id,
           after_created_at = excluded.after_created_at,
           created_at = excluded.created_at,
           items_json = excluded.items_json`,
      )
      .run(
        checkpoint.providerID,
        sessionID,
        checkpoint.responseID,
        checkpoint.afterMessageID,
        checkpoint.afterCreatedAt,
        checkpoint.createdAt,
        JSON.stringify(checkpoint.items),
      )
  }

  loadControlMessages() {
    return this.db
      .query<ControlMessageRow>(
        `select provider_id, session_id, message_id, created_at, content_text
         from control_messages
         order by provider_id, session_id, created_at, message_id`,
      )
      .all()
      .map(
        (row): ControlMessage => ({
          providerID: row.provider_id,
          sessionID: row.session_id,
          messageID: row.message_id,
          createdAt: row.created_at,
          contentText: row.content_text,
        }),
      )
  }

  upsertControlMessage(message: ControlMessage) {
    this.db
      .query(
        `insert into control_messages (provider_id, session_id, message_id, created_at, content_text)
         values (?, ?, ?, ?, ?)
         on conflict(provider_id, session_id, message_id) do update set
           created_at = excluded.created_at,
           content_text = excluded.content_text`,
      )
      .run(message.providerID, message.sessionID, message.messageID, message.createdAt, message.contentText)
  }

  deleteSession(sessionID: string) {
    this.db.query("delete from checkpoints where session_id = ?").run(sessionID)
    this.db.query("delete from control_messages where session_id = ?").run(sessionID)
  }

  deleteCheckpoint(sessionID: string, providerID: string, responseID: string) {
    this.db
      .query("delete from checkpoints where session_id = ? and provider_id = ? and response_id = ?")
      .run(sessionID, providerID, responseID)
  }

  deleteControlMessage(sessionID: string, messageID: string) {
    this.db.query("delete from control_messages where session_id = ? and message_id = ?").run(sessionID, messageID)
  }

  prune(retentionDays: number) {
    const cutoff = Date.now() - retentionDays * dayMs
    this.db.query("delete from checkpoints where created_at < ?").run(cutoff)
    this.db
      .query(
        `delete from control_messages
         where created_at < ?
           and not exists (
             select 1 from checkpoints
             where checkpoints.provider_id = control_messages.provider_id
               and checkpoints.session_id = control_messages.session_id
           )`,
      )
      .run(cutoff)
  }

  count() {
    const row = this.db.query<{ count: number }>("select count(*) as count from checkpoints").get()
    return row?.count ?? 0
  }

  version() {
    return this.schemaVersion()
  }

  private migrate() {
    const version = this.schemaVersion()
    if (version > schemaVersion) {
      throw new Error(`Unsupported openai-compact database schema version: ${version}`)
    }

    if (version === 0) {
      this.db.exec(`
        create table if not exists checkpoints (
          provider_id text not null,
          session_id text not null,
          response_id text not null,
          after_message_id text not null,
          after_created_at integer not null,
          created_at integer not null,
          items_json text not null,
          primary key (provider_id, session_id, response_id)
        );

        create index if not exists checkpoints_provider_session_boundary_idx
        on checkpoints (provider_id, session_id, after_created_at, created_at);

        create table if not exists control_messages (
          provider_id text not null,
          session_id text not null,
          message_id text not null,
          created_at integer not null,
          content_text text not null,
          primary key (provider_id, session_id, message_id)
        );

        create index if not exists control_messages_session_created_idx
        on control_messages (session_id, created_at);

        PRAGMA user_version = ${schemaVersion};
      `)
      return
    }

    if (version === 1) {
      this.db.exec(`
        create table if not exists control_messages (
          provider_id text not null,
          session_id text not null,
          message_id text not null,
          created_at integer not null,
          content_text text not null,
          primary key (provider_id, session_id, message_id)
        );

        create index if not exists control_messages_session_created_idx
        on control_messages (session_id, created_at);

        PRAGMA user_version = ${schemaVersion};
      `)
    }
  }

  private schemaVersion() {
    const row = this.db.query<{ user_version: number }>("PRAGMA user_version").get()
    return row?.user_version ?? 0
  }
}

export const currentSchemaVersion = schemaVersion

function configureFileDatabase(db: SQLiteDatabase) {
  db.query("PRAGMA journal_mode = WAL").get()
  db.exec(`
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
  `)
}
