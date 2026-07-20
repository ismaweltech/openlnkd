export interface DbAdapter {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  queryOne<T = any>(sql: string, params?: any[]): Promise<T | undefined>;
  execute(sql: string, params?: any[]): Promise<{ lastInsertRowid?: number }>;
  exec(sql: string): Promise<void>;
}
