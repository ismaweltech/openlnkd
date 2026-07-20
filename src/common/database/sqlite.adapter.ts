import Database from 'better-sqlite3';
import { DbAdapter } from './db.adapter';

export class SqliteAdapter implements DbAdapter {
  constructor(private db: Database.Database) {}

  async query<T>(sql: string, params: any[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async queryOne<T>(sql: string, params: any[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  async execute(sql: string, params: any[] = []): Promise<{ lastInsertRowid?: number }> {
    const result = this.db.prepare(sql).run(...params);
    return { lastInsertRowid: Number(result.lastInsertRowid) };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }
}
