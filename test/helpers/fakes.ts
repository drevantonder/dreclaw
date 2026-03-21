import type { Env } from "../../src/cloudflare/env";
import { runConversationWorkflow, runRemindersWakeWorkflow } from "../../src/app/cloudflare";
import type {
  ConversationWorkflowPayload,
  ReminderWakeWorkflowPayload,
} from "../../src/cloudflare/env";

type SqlResult = { meta: { changes?: number } };

const pendingWorkflowTasks: Promise<unknown>[] = [];

export async function waitForWorkflowTasks(): Promise<void> {
  await Promise.allSettled(pendingWorkflowTasks.splice(0));
}

export class FakeD1 {
  readonly telegramUpdates = new Set<number>();
  readonly oauthStates = new Map<string, Record<string, unknown>>();
  readonly oauthTokens = new Map<string, Record<string, unknown>>();
  readonly subscriptions = new Map<string, Record<string, unknown>>();
  readonly kv = new Map<string, Record<string, unknown>>();
  readonly locks = new Map<string, Record<string, unknown>>();
  readonly chatInbox = new Map<string, Record<string, unknown>>();
  readonly remindersProfile = new Map<number, Record<string, unknown>>();
  readonly remindersItems = new Map<string, Record<string, unknown>>();
  readonly reminderRuns = new Map<string, Record<string, unknown>>();

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        run: async () => this.run(sql, args),
        all: async () => this.all(sql, args),
        first: async () => this.first(sql, args),
      }),
      all: async () => this.all(sql, []),
      first: async () => this.first(sql, []),
    };
  }

  private async run(sql: string, args: unknown[]): Promise<SqlResult> {
    if (sql.includes("INSERT INTO google_oauth_states")) {
      this.oauthStates.set(String(args[0]), {
        state: String(args[0]),
        chat_id: Number(args[1]),
        telegram_user_id: Number(args[2]),
        expires_at: String(args[3]),
        used_at: null,
        created_at: String(args[4]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO reminders_profile")) {
      const existing = this.remindersProfile.get(1);
      this.remindersProfile.set(1, {
        id: 1,
        timezone: String(args[0]),
        primary_chat_id: args[1] == null ? (existing?.primary_chat_id ?? null) : Number(args[1]),
        updated_at: String(args[2]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO reminders_items")) {
      this.remindersItems.set(String(args[0]), {
        id: String(args[0]),
        kind: String(args[1]),
        title: String(args[2]),
        notes: String(args[3]),
        delivery_mode: String(args[4]),
        status: String(args[5]),
        priority: Number(args[6]),
        schedule_json: stringifyPrimitive(args[7]),
        next_wake_at: stringifyPrimitive(args[8]),
        last_wake_at: stringifyPrimitive(args[9]),
        snooze_until: stringifyPrimitive(args[10]),
        source_chat_id: args[11] == null ? null : Number(args[11]),
        claimed_at: null,
        claim_token: null,
        workflow_id: null,
        created_at: String(args[12]),
        updated_at: String(args[13]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE reminders_items SET claimed_at = ?")) {
      const row = this.remindersItems.get(String(args[3]));
      if (!row) return { meta: { changes: 0 } };
      if (
        row.status !== "open" ||
        !row.next_wake_at ||
        stringifyPrimitive(row.next_wake_at)! > String(args[4]) ||
        row.workflow_id != null ||
        (row.claimed_at != null && stringifyPrimitive(row.claimed_at)! >= String(args[5]))
      ) {
        return { meta: { changes: 0 } };
      }
      row.claimed_at = String(args[0]);
      row.claim_token = String(args[1]);
      row.updated_at = String(args[2]);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE reminders_items SET workflow_id = ?")) {
      const row = this.remindersItems.get(String(args[2]));
      if (!row || String(row.claim_token) !== String(args[3])) return { meta: { changes: 0 } };
      row.workflow_id = String(args[0]);
      row.updated_at = String(args[1]);
      return { meta: { changes: 1 } };
    }
    if (
      sql.includes(
        "UPDATE reminders_items SET claimed_at = NULL, claim_token = NULL, workflow_id = NULL",
      )
    ) {
      const row = this.remindersItems.get(String(args[1]));
      if (!row || String(row.claim_token) !== String(args[2])) return { meta: { changes: 0 } };
      row.claimed_at = null;
      row.claim_token = null;
      row.workflow_id = null;
      row.updated_at = String(args[0]);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE reminders_items SET")) {
      const row = this.remindersItems.get(String(args[args.length - 1]));
      if (!row) return { meta: { changes: 0 } };
      const assignments = sql
        .slice(sql.indexOf("SET") + 3, sql.lastIndexOf("WHERE"))
        .split(",")
        .map((entry) => entry.trim());
      let bindIndex = 0;
      for (const assignment of assignments) {
        const column = assignment.split("=")[0]?.trim();
        if (!column) continue;
        row[column] = args[bindIndex] ?? null;
        bindIndex += 1;
      }
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO reminders_wake_runs")) {
      this.reminderRuns.set(String(args[0]), {
        id: String(args[0]),
        reminder_id: String(args[1]),
        scheduled_for: String(args[2]),
        started_at: String(args[3]),
        finished_at: null,
        outcome: null,
        summary: null,
        error: null,
        next_wake_at: null,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE reminders_wake_runs SET finished_at = ?")) {
      const row = this.reminderRuns.get(String(args[5]));
      if (!row) return { meta: { changes: 0 } };
      row.finished_at = String(args[0]);
      row.outcome = String(args[1]);
      row.summary = stringifyPrimitive(args[2]);
      row.error = stringifyPrimitive(args[3]);
      row.next_wake_at = stringifyPrimitive(args[4]);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT OR IGNORE INTO telegram_updates")) {
      const updateId = Number(args[0]);
      if (this.telegramUpdates.has(updateId)) return { meta: { changes: 0 } };
      this.telegramUpdates.add(updateId);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE google_oauth_states SET used_at")) {
      const row = this.oauthStates.get(String(args[1]));
      if (!row || row.used_at) return { meta: { changes: 0 } };
      row.used_at = String(args[0]);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO google_oauth_tokens")) {
      this.oauthTokens.set(String(args[0]), {
        principal: String(args[0]),
        telegram_user_id: args[1] == null ? null : Number(args[1]),
        refresh_token_ciphertext: String(args[2]),
        nonce: String(args[3]),
        scopes: String(args[4]),
        updated_at: String(args[5]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM google_oauth_tokens")) {
      return { meta: { changes: this.oauthTokens.delete(String(args[0])) ? 1 : 0 } };
    }
    if (sql.includes("INSERT INTO chat_state_subscriptions")) {
      this.subscriptions.set(String(args[0]), {
        thread_id: String(args[0]),
        created_at: String(args[1]),
        updated_at: String(args[2]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM chat_state_subscriptions")) {
      return { meta: { changes: this.subscriptions.delete(String(args[0])) ? 1 : 0 } };
    }
    if (sql.includes("INSERT OR IGNORE INTO chat_inbox")) {
      const key = String(args[0]);
      const updateId = Number(args[2]);
      if (
        this.chatInbox.has(key) ||
        [...this.chatInbox.values()].some((row) => Number(row.update_id) === updateId)
      ) {
        return { meta: { changes: 0 } };
      }
      this.chatInbox.set(key, {
        id: key,
        chat_id: Number(args[1]),
        update_id: updateId,
        text_json: String(args[3]),
        created_at: String(args[4]),
        consumed_at: null,
        consumed_by_run_id: null,
      });
      return { meta: { changes: 1 } };
    }
    if (
      sql.includes(
        "UPDATE chat_inbox SET consumed_at = ?, consumed_by_run_id = ? WHERE id = ? AND consumed_at IS NULL",
      )
    ) {
      const row = this.chatInbox.get(String(args[2]));
      if (!row || row.consumed_at != null) return { meta: { changes: 0 } };
      row.consumed_at = String(args[0]);
      row.consumed_by_run_id = String(args[1]);
      return { meta: { changes: 1 } };
    }
    if (
      sql.includes(
        "UPDATE chat_inbox SET consumed_at = NULL, consumed_by_run_id = NULL WHERE id = ? AND consumed_by_run_id = ?",
      )
    ) {
      const row = this.chatInbox.get(String(args[0]));
      if (!row || String(row.consumed_by_run_id) !== String(args[1])) {
        return { meta: { changes: 0 } };
      }
      row.consumed_at = null;
      row.consumed_by_run_id = null;
      return { meta: { changes: 1 } };
    }
    if (
      sql.includes(
        "UPDATE chat_inbox SET consumed_at = ?, consumed_by_run_id = 'cancelled' WHERE chat_id = ? AND consumed_at IS NULL",
      )
    ) {
      let changes = 0;
      for (const row of this.chatInbox.values()) {
        if (Number(row.chat_id) !== Number(args[1]) || row.consumed_at != null) continue;
        row.consumed_at = String(args[0]);
        row.consumed_by_run_id = "cancelled";
        changes += 1;
      }
      return { meta: { changes } };
    }
    if (
      sql.includes("INSERT INTO chat_state_kv") ||
      sql.includes("INSERT OR IGNORE INTO chat_state_kv")
    ) {
      const key = String(args[0]);
      const exists = this.kv.has(key);
      if (sql.includes("INSERT OR IGNORE") && exists) return { meta: { changes: 0 } };
      this.kv.set(key, {
        key,
        value_json: String(args[1]),
        expires_at: stringifyPrimitive(args[2]),
        updated_at: String(args[3]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM chat_state_kv WHERE key = ? AND expires_at")) {
      const row = this.kv.get(String(args[0]));
      const expiresAt = stringifyPrimitive(args[1]);
      if (!row || row.expires_at == null || expiresAt == null || row.expires_at > expiresAt)
        return { meta: { changes: 0 } };
      this.kv.delete(String(args[0]));
      return { meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM chat_state_kv WHERE key = ?")) {
      return { meta: { changes: this.kv.delete(String(args[0])) ? 1 : 0 } };
    }
    if (sql.includes("DELETE FROM chat_state_locks WHERE thread_id = ? AND expires_at")) {
      const row = this.locks.get(String(args[0]));
      if (!row || String(row.expires_at) > String(args[1])) return { meta: { changes: 0 } };
      this.locks.delete(String(args[0]));
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT OR IGNORE INTO chat_state_locks")) {
      const key = String(args[0]);
      if (this.locks.has(key)) return { meta: { changes: 0 } };
      this.locks.set(key, {
        thread_id: key,
        token: String(args[1]),
        expires_at: String(args[2]),
        created_at: String(args[3]),
        updated_at: String(args[4]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE chat_state_locks SET expires_at")) {
      const row = this.locks.get(String(args[2]));
      if (
        !row ||
        String(row.token) !== String(args[3]) ||
        String(row.expires_at) <= String(args[4])
      )
        return { meta: { changes: 0 } };
      row.expires_at = String(args[0]);
      row.updated_at = String(args[1]);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM chat_state_locks WHERE thread_id = ? AND token = ?")) {
      const row = this.locks.get(String(args[0]));
      if (!row || String(row.token) !== String(args[1])) return { meta: { changes: 0 } };
      this.locks.delete(String(args[0]));
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }

  private async first(sql: string, args: unknown[]): Promise<Record<string, unknown> | null> {
    if (sql.includes("FROM google_oauth_states"))
      return this.oauthStates.get(String(args[0])) ?? null;
    if (sql.includes("FROM google_oauth_tokens"))
      return this.oauthTokens.get(String(args[0])) ?? null;
    if (sql.includes("FROM chat_state_locks WHERE thread_id = ? AND expires_at > ?")) {
      const row = this.locks.get(String(args[0]));
      if (!row || String(row.expires_at) <= String(args[1])) return null;
      return row;
    }
    if (sql.includes("FROM reminders_profile")) return this.remindersProfile.get(1) ?? null;
    if (sql.includes("FROM reminders_items WHERE id = ?"))
      return this.remindersItems.get(String(args[0])) ?? null;
    if (sql.includes("FROM reminders_wake_runs WHERE id = ?"))
      return this.reminderRuns.get(String(args[0])) ?? null;
    if (sql.includes("FROM chat_state_subscriptions"))
      return this.subscriptions.get(String(args[0])) ?? null;
    if (sql.includes("SELECT value_json FROM chat_state_kv"))
      return this.kv.get(String(args[0])) ?? null;
    return null;
  }

  private async all(
    sql: string,
    args: unknown[],
  ): Promise<{ results: Array<Record<string, unknown>> }> {
    if (sql.includes("FROM chat_inbox WHERE chat_id = ? AND consumed_at IS NULL")) {
      return {
        results: [...this.chatInbox.values()]
          .filter((row) => Number(row.chat_id) === Number(args[0]) && row.consumed_at == null)
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
          .slice(0, Number(args[1] ?? 1)),
      };
    }
    if (sql.includes("FROM reminders_items")) {
      let rows = [...this.remindersItems.values()];
      if (sql.includes("status = 'open'")) rows = rows.filter((row) => row.status === "open");
      if (sql.includes("next_wake_at <= ?"))
        rows = rows.filter(
          (row) => row.next_wake_at && stringifyPrimitive(row.next_wake_at)! <= String(args[0]),
        );
      if (sql.includes("workflow_id IS NULL")) rows = rows.filter((row) => row.workflow_id == null);
      if (sql.includes("status = ?")) rows = rows.filter((row) => row.status === args[0]);
      if (sql.includes("kind = ?")) {
        const kindArg = args[sql.includes("status = ?") ? 1 : 0];
        rows = rows.filter((row) => row.kind === kindArg);
      }
      if (sql.includes("source_chat_id = ?")) {
        const index = sql.includes("status = ?") || sql.includes("kind = ?") ? 1 : 0;
        rows = rows.filter((row) => Number(row.source_chat_id) === Number(args[index]));
      }
      if (sql.includes("title LIKE ? OR notes LIKE ?")) {
        const textArgs = args.filter(
          (value) => typeof value === "string" && String(value).includes("%"),
        );
        const needle = (stringifyPrimitive(textArgs[0]) ?? "").replace(/%/g, "").toLowerCase();
        rows = rows.filter(
          (row) =>
            String(row.title).toLowerCase().includes(needle) ||
            String(row.notes).toLowerCase().includes(needle),
        );
      }
      return {
        results: rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
      };
    }
    if (sql.includes("FROM reminders_wake_runs WHERE reminder_id = ?")) {
      return {
        results: [...this.reminderRuns.values()]
          .filter((row) => row.reminder_id === args[0])
          .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at))),
      };
    }
    return { results: [] };
  }
}

function stringifyPrimitive(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

export function createEnv(overrides?: Partial<Env>) {
  const db = new FakeD1();
  const env: Env = {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    TELEGRAM_BOT_USERNAME: "dreclawbot",
    TELEGRAM_ALLOWED_USER_ID: "42",
    MODEL: "test-model",
    AI: {} as Ai,
    OPENCODE_API_KEY: "test-key",
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    GOOGLE_OAUTH_REDIRECT_URI: "https://test.local/google/oauth/callback",
    GOOGLE_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    MEMORY_ENABLED: "false",
    DRECLAW_DB: db as unknown as D1Database,
    ...overrides,
  };
  env.CONVERSATION_WORKFLOW ??= createImmediateConversationWorkflow(
    env,
  ) as unknown as Env["CONVERSATION_WORKFLOW"];
  env.REMINDERS_WAKE_WORKFLOW ??= createImmediateReminderWakeWorkflow(
    env,
  ) as unknown as Env["REMINDERS_WAKE_WORKFLOW"];
  return { env, db };
}

function createImmediateConversationWorkflow(env: Env) {
  const statuses = new Map<string, string>();
  return {
    async create(input: { id: string; params: ConversationWorkflowPayload }) {
      statuses.set(input.id, "running");
      const task = (async () => {
        try {
          await runConversationWorkflow(
            env,
            createWorkflowCtx(),
            { payload: input.params } as never,
            {
              do: async (_name: string, execute: () => Promise<unknown>) => execute(),
              sleep: async (_name: string, duration: number | string) => {
                const ms = typeof duration === "number" ? duration : Number(duration);
                await new Promise((resolve) => setTimeout(resolve, Number.isFinite(ms) ? ms : 0));
              },
            } as never,
          );
          statuses.set(input.id, "complete");
        } catch (error) {
          statuses.set(input.id, "failed");
          throw error;
        }
      })();
      pendingWorkflowTasks.push(task);
      return { id: input.id };
    },
    async get(id: string) {
      return {
        async terminate() {
          statuses.set(id, "terminated");
        },
        async status() {
          return { status: statuses.get(id) ?? "unknown" };
        },
      };
    },
  };
}

function createImmediateReminderWakeWorkflow(env: Env) {
  const statuses = new Map<string, string>();
  return {
    async create(input: { id: string; params: ReminderWakeWorkflowPayload }) {
      statuses.set(input.id, "running");
      const task = (async () => {
        try {
          await runRemindersWakeWorkflow(
            env,
            createWorkflowCtx(),
            { payload: input.params } as never,
            { do: async (_name: string, execute: () => Promise<unknown>) => execute() } as never,
          );
          statuses.set(input.id, "complete");
        } catch (error) {
          statuses.set(input.id, "failed");
          throw error;
        }
      })();
      pendingWorkflowTasks.push(task);
      return { id: input.id };
    },
    async get(id: string) {
      return {
        async terminate() {
          statuses.set(id, "terminated");
        },
        async status() {
          return { status: statuses.get(id) ?? "unknown" };
        },
      };
    },
  };
}

function createWorkflowCtx(): ExecutionContext {
  return {
    waitUntil() {
      return;
    },
    passThroughOnException() {
      return;
    },
    props: {},
  } as ExecutionContext;
}
