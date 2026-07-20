import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import { DbAdapter } from './db.adapter';
import { SqliteAdapter } from './sqlite.adapter';
import { PostgresAdapter } from './postgres.adapter';

const SQLITE_MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS session (
    id INTEGER PRIMARY KEY,
    cookies TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT,
    remote TEXT,
    url TEXT NOT NULL,
    posted_at TEXT,
    description TEXT,
    easy_apply INTEGER DEFAULT 0,
    applied INTEGER DEFAULT 0,
    saved INTEGER DEFAULT 0,
    scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT,
    industry TEXT,
    size TEXT,
    headline TEXT,
    location TEXT,
    follower_count TEXT,
    company_type TEXT,
    scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    headline TEXT,
    profile_url TEXT NOT NULL UNIQUE,
    invite_status TEXT DEFAULT 'pending',
    message_sent INTEGER DEFAULT 0,
    note TEXT,
    connected_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_url TEXT NOT NULL,
    content TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    subject TEXT,
    body TEXT NOT NULL,
    variables TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    headline TEXT,
    location TEXT,
    profile_url TEXT NOT NULL UNIQUE,
    connection_degree TEXT,
    company TEXT,
    scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    template_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    total INTEGER DEFAULT 0,
    sent INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    delay_min INTEGER DEFAULT 30,
    delay_max INTEGER DEFAULT 90,
    filter_connections INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    finished_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS campaign_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    profile_url TEXT NOT NULL,
    name TEXT,
    status TEXT DEFAULT 'pending',
    message_sent TEXT,
    error TEXT,
    sent_at DATETIME,
    is_connection INTEGER DEFAULT NULL
  );
  CREATE TABLE IF NOT EXISTS location_cache (
    query TEXT NOT NULL,
    geo_id TEXT NOT NULL,
    label TEXT NOT NULL,
    label_normalized TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (query, geo_id)
  );
  CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    url TEXT NOT NULL,
    secret TEXT,
    events TEXT DEFAULT '["new_messages"]',
    interval_sec INTEGER DEFAULT 300,
    active INTEGER DEFAULT 1,
    last_checked_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS webhook_seen (
    fingerprint TEXT PRIMARY KEY,
    seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

const POSTGRES_MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS session (
    id INTEGER PRIMARY KEY,
    cookies TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT,
    remote TEXT,
    url TEXT NOT NULL,
    posted_at TEXT,
    description TEXT,
    easy_apply INTEGER DEFAULT 0,
    applied INTEGER DEFAULT 0,
    saved INTEGER DEFAULT 0,
    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT,
    industry TEXT,
    size TEXT,
    headline TEXT,
    location TEXT,
    follower_count TEXT,
    company_type TEXT,
    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    headline TEXT,
    profile_url TEXT NOT NULL UNIQUE,
    invite_status TEXT DEFAULT 'pending',
    message_sent INTEGER DEFAULT 0,
    note TEXT,
    connected_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    profile_url TEXT NOT NULL,
    content TEXT NOT NULL,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS templates (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    subject TEXT,
    body TEXT NOT NULL,
    variables TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    headline TEXT,
    location TEXT,
    profile_url TEXT NOT NULL UNIQUE,
    connection_degree TEXT,
    company TEXT,
    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS campaigns (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    template_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    total INTEGER DEFAULT 0,
    sent INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    delay_min INTEGER DEFAULT 30,
    delay_max INTEGER DEFAULT 90,
    filter_connections INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    finished_at TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS campaign_targets (
    id SERIAL PRIMARY KEY,
    campaign_id INTEGER NOT NULL,
    profile_url TEXT NOT NULL,
    name TEXT,
    status TEXT DEFAULT 'pending',
    message_sent TEXT,
    error TEXT,
    sent_at TIMESTAMP,
    is_connection INTEGER DEFAULT NULL
  );
  CREATE TABLE IF NOT EXISTS location_cache (
    query TEXT NOT NULL,
    geo_id TEXT NOT NULL,
    label TEXT NOT NULL,
    label_normalized TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (query, geo_id)
  );
`;

@Injectable()
export class DatabaseService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseService.name);
  private adapter: DbAdapter;

  async onModuleInit() {
    const databaseUrl = process.env.DATABASE_URL;

    if (databaseUrl?.startsWith('postgres')) {
      this.logger.log('Using PostgreSQL');
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: databaseUrl });
      this.adapter = new PostgresAdapter(pool);
      // Run each statement separately for PostgreSQL
      for (const stmt of POSTGRES_MIGRATIONS.split(';').map((s) => s.trim()).filter(Boolean)) {
        await this.adapter.exec(stmt);
      }
    } else {
      this.logger.log('Using SQLite');
      const dbPath = process.env.DATABASE_PATH ?? './data/openlnkd.db';
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      this.adapter = new SqliteAdapter(db);
      await this.adapter.exec(SQLITE_MIGRATIONS);
      // Safe schema migrations for existing DBs (ignored if column already exists)
      await this.adapter.exec(`ALTER TABLE location_cache ADD COLUMN label_normalized TEXT`).catch(() => {});
      await this.adapter.exec(`ALTER TABLE companies ADD COLUMN headline TEXT`).catch(() => {});
      await this.adapter.exec(`ALTER TABLE companies ADD COLUMN location TEXT`).catch(() => {});
      await this.adapter.exec(`ALTER TABLE companies ADD COLUMN follower_count TEXT`).catch(() => {});
      await this.adapter.exec(`ALTER TABLE companies ADD COLUMN company_type TEXT`).catch(() => {});
      await this.adapter.exec(`ALTER TABLE companies ADD COLUMN linkedin_id TEXT`).catch(() => {});
      await this.adapter.exec(`ALTER TABLE webhooks ADD COLUMN name TEXT`).catch(() => {});
      await this.adapter.exec(`ALTER TABLE webhooks ADD COLUMN events TEXT DEFAULT '["new_messages"]'`).catch(() => {});
    }
  }

  query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    return this.adapter.query<T>(sql, params);
  }

  queryOne<T = any>(sql: string, params?: any[]): Promise<T | undefined> {
    return this.adapter.queryOne<T>(sql, params);
  }

  execute(sql: string, params?: any[]): Promise<{ lastInsertRowid?: number }> {
    return this.adapter.execute(sql, params);
  }

  exec(sql: string): Promise<void> {
    return this.adapter.exec(sql);
  }
}
