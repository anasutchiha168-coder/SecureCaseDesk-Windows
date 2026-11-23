// SECURECASEDESK_PHASE3_COMPLETION
// سجل تعديل القضايا: للإلحاق فقط (لا تعديل ولا حذف) بمشغلات مثل correction_history.
export interface CasesSchemaDb { execAsync(sql: string): Promise<void> }

export async function initCaseHistorySchema(db: CasesSchemaDb): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS case_history (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('update','status','archive','unarchive','assign','transfer')),
      field_name TEXT NOT NULL,
      previous_value TEXT,
      new_value TEXT,
      reason TEXT,
      executed_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (case_id) REFERENCES cases(id),
      FOREIGN KEY (executed_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_case_history_case ON case_history(case_id, created_at);
    CREATE TRIGGER IF NOT EXISTS trg_case_history_no_update
    BEFORE UPDATE ON case_history
    BEGIN SELECT RAISE(ABORT, 'سجل تعديل القضايا غير قابل للتعديل'); END;
    CREATE TRIGGER IF NOT EXISTS trg_case_history_no_delete
    BEFORE DELETE ON case_history
    BEGIN SELECT RAISE(ABORT, 'سجل تعديل القضايا غير قابل للحذف'); END;
  `);
}
