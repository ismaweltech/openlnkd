import { Pool } from 'pg';
import { DbAdapter } from './db.adapter';

export class PostgresAdapter implements DbAdapter {
  constructor(private pool: Pool) {}

  private normalize(sql: string, params: any[]): { sql: string; params: any[] } {
    // Convert ? to $N
    let i = 0;
    const out = sql
      .replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO')
      .replace(/INSERT OR REPLACE INTO/gi, 'INSERT INTO')
      .replace(/\?/g, () => `$${++i}`);
    return { sql: out, params };
  }

  async query<T>(sql: string, params: any[] = []): Promise<T[]> {
    const { sql: s, params: p } = this.normalize(sql, params);
    const { rows } = await this.pool.query(s, p);
    return rows as T[];
  }

  async queryOne<T>(sql: string, params: any[] = []): Promise<T | undefined> {
    const { sql: s, params: p } = this.normalize(sql, params);
    const { rows } = await this.pool.query(s, p);
    return rows[0] as T | undefined;
  }

  async execute(sql: string, params: any[] = []): Promise<{ lastInsertRowid?: number }> {
    const { sql: normalized, params: p } = this.normalize(sql, params);
    const isInsert = /^\s*INSERT\s/i.test(normalized);
    const hasReturning = /\bRETURNING\b/i.test(normalized);
    const finalSql = isInsert && !hasReturning ? `${normalized} RETURNING id` : normalized;
    try {
      const { rows } = await this.pool.query(finalSql, p);
      return { lastInsertRowid: rows[0]?.id ? Number(rows[0].id) : undefined };
    } catch {
      // Table may not have `id` column — retry without RETURNING
      if (isInsert && !hasReturning) {
        await this.pool.query(normalized, p);
        return {};
      }
      throw new Error('PostgreSQL query failed');
    }
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }
}
