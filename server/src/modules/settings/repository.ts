import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/**
 * F1 — settings data-access layer (extracted from routes.ts; no behaviour
 * change). The ONLY place that touches the `settings` table.
 *
 * Non-secret preferences only, stored as key/value rows. Provider keys live
 * behind the SecretsProvider adapter and never reach this table.
 */

export type SettingRow = typeof t.settings.$inferSelect;

export class SettingsRepository {
  constructor(private db: Db) {}

  async listByWorkspace(workspaceId: string): Promise<SettingRow[]> {
    return this.db.select().from(t.settings).where(eq(t.settings.workspaceId, workspaceId));
  }

  /** Upsert one preference row, keyed by (workspace, user, key). */
  async upsert(
    workspaceId: string,
    userId: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    await this.db
      .insert(t.settings)
      .values({ workspaceId, userId, key, value })
      .onConflictDoUpdate({
        target: [t.settings.workspaceId, t.settings.userId, t.settings.key],
        set: { value },
      });
  }
}
