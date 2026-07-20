import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';

export interface Template {
  id: number;
  name: string;
  subject: string | null;
  body: string;
  variables: string[];
  created_at: string;
}

export interface CreateTemplateDto {
  name: string;
  subject?: string;
  body: string;
}

@Injectable()
export class TemplatesService {
  constructor(private readonly db: DatabaseService) {}

  async create(dto: CreateTemplateDto): Promise<Template> {
    const vars = this.extractVariables(dto.body);
    const result = await this.db.execute(
      `INSERT INTO templates (name, subject, body, variables)
       VALUES (?, ?, ?, ?)`,
      [dto.name, dto.subject ?? null, dto.body, JSON.stringify(vars)],
    );
    return this.findOne(result.lastInsertRowid!);
  }

  async findAll(): Promise<Template[]> {
    const rows = await this.db.query<any>('SELECT * FROM templates ORDER BY created_at DESC');
    return rows.map(this.rowToTemplate);
  }

  async findOne(id: number): Promise<Template> {
    const row = await this.db.queryOne<any>('SELECT * FROM templates WHERE id = ?', [id]);
    if (!row) throw new NotFoundException(`Template ${id} not found`);
    return this.rowToTemplate(row);
  }

  async delete(id: number): Promise<{ ok: boolean }> {
    await this.findOne(id); // throws if not found
    await this.db.execute('DELETE FROM templates WHERE id = ?', [id]);
    return { ok: true };
  }

  /**
   * Render a template replacing {variable} placeholders with provided values.
   * Remaining placeholders left untouched — caller decides what to do with them.
   */
  async render(templateId: number, vars: Record<string, string>): Promise<string> {
    const tpl = await this.findOne(templateId);
    return tpl.body.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
  }

  extractVariables(body: string): string[] {
    const matches = body.match(/\{(\w+)\}/g) ?? [];
    return [...new Set(matches.map((m) => m.slice(1, -1)))];
  }

  private rowToTemplate(row: any): Template {
    return {
      ...row,
      variables: row.variables ? JSON.parse(row.variables) : [],
    };
  }
}
