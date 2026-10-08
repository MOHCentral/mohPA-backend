/**
 * mohPA Database Connection Pool & Client Layer
 * Supports PostgreSQL connection pool with in-memory fallback for isolated testing.
 */

import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface DbClient {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  isPostgres(): boolean;
}

/**
 * PostgreSQL Database Client Wrapper
 */
export class PostgresDbClient implements DbClient {
  public pool: pg.Pool;

  constructor(connectionStringOrConfig?: string | pg.PoolConfig) {
    if (typeof connectionStringOrConfig === 'string') {
      this.pool = new Pool({ connectionString: connectionStringOrConfig });
    } else if (connectionStringOrConfig) {
      this.pool = new Pool(connectionStringOrConfig);
    } else {
      const connectionString = process.env.DATABASE_URL || 'postgresql://mohpa:mohpa@localhost:5432/mohpa';
      this.pool = new Pool({ connectionString });
    }

    // Error handler for idle clients
    this.pool.on('error', (err) => {
      console.error('[DB] Unexpected error on idle PostgreSQL client:', err);
    });
  }

  public async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    const res = await this.pool.query<any>(sql, params);
    if (Array.isArray(res)) {
      const last = res[res.length - 1];
      return {
        rows: (last?.rows || []) as T[],
        rowCount: last?.rowCount ?? last?.rows?.length ?? 0
      };
    }
    return {
      rows: (res.rows || []) as T[],
      rowCount: res.rowCount ?? res.rows?.length ?? 0
    };
  }

  public async transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txClient: DbClient = {
        query: async <R = any>(text: string, params?: any[]) => {
          const res = await client.query<any>(text, params);
          if (Array.isArray(res)) {
            const last = res[res.length - 1];
            return {
              rows: (last?.rows || []) as R[],
              rowCount: last?.rowCount ?? last?.rows?.length ?? 0
            };
          }
          return { rows: (res.rows || []) as R[], rowCount: res.rowCount ?? res.rows?.length ?? 0 };
        },
        transaction: () => {
          throw new Error('Nested transactions not supported');
        },
        close: async () => {},
        isPostgres: () => true
      };
      const result = await fn(txClient);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public isPostgres(): boolean {
    return true;
  }
}

/**
 * High-performance In-Memory SQL database adapter for unit/integration tests
 * when PostgreSQL is unavailable.
 */
export class MemoryDbClient implements DbClient {
  public tables: Map<string, Array<Record<string, any>>> = new Map();

  constructor() {
    this.initTables();
  }

  public initTables(): void {
    this.tables.set('users', []);
    this.tables.set('personas', []);
    this.tables.set('entitlements', []);
    this.tables.set('game_servers', []);
    this.tables.set('persona_stats', []);
    this.tables.set('match_history', []);
    this.tables.set('audit_logs', []);
    this.tables.set('server_history_snapshots', []);
    this.tables.set('server_player_sessions', []);
    this.tables.set('_migrations', []);
  }

  public async query<T = any>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
    const trimmed = sql.trim().replace(/;+$/, '');

    // Handle migrations table check/creation
    if (trimmed.toLowerCase().includes('create table if not exists') || trimmed.toLowerCase().includes('create extension')) {
      return { rows: [], rowCount: 0 };
    }

    // Handle SELECT
    if (trimmed.toUpperCase().startsWith('SELECT')) {
      return this.handleSelect<T>(trimmed, params);
    }

    // Handle INSERT
    if (trimmed.toUpperCase().startsWith('INSERT')) {
      return this.handleInsert<T>(trimmed, params);
    }

    // Handle UPDATE
    if (trimmed.toUpperCase().startsWith('UPDATE')) {
      return this.handleUpdate<T>(trimmed, params);
    }

    // Handle DELETE
    if (trimmed.toUpperCase().startsWith('DELETE')) {
      return this.handleDelete<T>(trimmed, params);
    }

    return { rows: [], rowCount: 0 };
  }

  private handleSelect<T>(sql: string, params: any[]): QueryResult<T> {
    // Determine target table
    const fromMatch = sql.match(/FROM\s+([a-zA-Z0-9_]+)/i);
    if (!fromMatch) {
      return { rows: [], rowCount: 0 };
    }

    const tableName = fromMatch[1].toLowerCase();
    const table = this.tables.get(tableName) || [];
    let rows = table.map(r => ({ ...r }));

    // Handle persona stats join if requested
    if (tableName === 'personas' && sql.toLowerCase().includes('persona_stats')) {
      const statsTable = this.tables.get('persona_stats') || [];
      rows = rows.map(p => {
        const stats = statsTable.find(s => s.persona_id === p.id) || {
          score: 0, kills: 0, deaths: 0, wins: 0, losses: 0, time_played_seconds: 0, custom_stats: {}
        };
        return {
          ...p,
          score: stats.score,
          kills: stats.kills,
          deaths: stats.deaths,
          wins: stats.wins,
          losses: stats.losses,
          time_played_seconds: stats.time_played_seconds,
          custom_stats: stats.custom_stats
        };
      });
    }

    // Handle leaderboard join from users
    if (tableName === 'users' && sql.toLowerCase().includes('personas')) {
      const personasTable = this.tables.get('personas') || [];
      const statsTable = this.tables.get('persona_stats') || [];

      const targetGameParam = params.find(p => typeof p === 'string');
      const targetGame = targetGameParam ? String(targetGameParam).toLowerCase() : 'mohpa';

      const combined: Array<Record<string, any>> = [];
      for (const user of rows) {
        if (user.is_banned) continue;
        const userPersonas = personasTable.filter(
          p => p.user_id === user.id && p.game_slug?.toLowerCase() === targetGame && p.is_active !== false
        );

        if (userPersonas.length === 0) {
          combined.push({
            ...user,
            persona_id: user.id,
            score: 0,
            kills: 0,
            deaths: 0,
            wins: 0,
            losses: 0,
            time_played_seconds: 0,
            custom_stats: {},
            persona_name: user.username,
            name: user.username,
            user_id: user.id,
            game_slug: targetGame,
            created_at: user.created_at
          });
        } else {
          for (const p of userPersonas) {
            const stats = statsTable.find(s => s.persona_id === p.id) || {
              score: 0, kills: 0, deaths: 0, wins: 0, losses: 0, time_played_seconds: 0, custom_stats: {}
            };
            combined.push({
              ...user,
              ...stats,
              persona_id: p.id,
              persona_name: p.name,
              name: p.name,
              user_id: user.id,
              game_slug: p.game_slug,
              created_at: p.created_at || user.created_at
            });
          }
        }
      }
      rows = combined;
    }

    // Handle leaderboard join
    if (tableName === 'persona_stats' && sql.toLowerCase().includes('personas')) {
      const personasTable = this.tables.get('personas') || [];
      rows = rows.map(s => {
        const persona = personasTable.find(p => p.id === s.persona_id);
        return {
          ...s,
          persona_name: persona?.name || '',
          user_id: persona?.user_id || '',
          game_slug: persona?.game_slug || '',
          is_active: persona ? persona.is_active : true
        };
      });
    }

    // Apply basic filter matching from WHERE clause
    const whereMatch = sql.match(/WHERE\s+(.*?)(ORDER BY|LIMIT|OFFSET|GROUP BY|$)/is);
    if (whereMatch) {
      const whereClause = whereMatch[1];
      rows = rows.filter(row => this.evaluateWhere(whereClause, row, params));
    }

    // Handle GROUP BY on server_player_sessions
    if (tableName === 'server_player_sessions' && sql.toUpperCase().includes('GROUP BY')) {
      const groups = new Map<string, any>();
      for (const row of rows) {
        const key = String(row.player_name || '').toLowerCase();
        if (!groups.has(key)) {
          groups.set(key, {
            player_name: row.player_name,
            score: Number(row.score || 0),
            kills: Number(row.kills || 0),
            deaths: Number(row.deaths || 0),
            total_duration: Number(row.duration_seconds || 0),
            session_count: 1,
            first_seen: row.first_seen,
            last_seen: row.last_seen,
          });
        } else {
          const g = groups.get(key)!;
          g.score = Math.max(g.score, Number(row.score || 0));
          g.kills = Math.max(g.kills, Number(row.kills || 0));
          g.deaths = Math.max(g.deaths, Number(row.deaths || 0));
          g.total_duration += Number(row.duration_seconds || 0);
          g.session_count += 1;
          if (new Date(row.first_seen).getTime() < new Date(g.first_seen).getTime()) {
            g.first_seen = row.first_seen;
          }
          if (new Date(row.last_seen).getTime() > new Date(g.last_seen).getTime()) {
            g.last_seen = row.last_seen;
          }
        }
      }
      rows = Array.from(groups.values());
    }

    // Handle COUNT(*)
    if (sql.toUpperCase().includes('COUNT(') && !sql.toUpperCase().includes('GROUP BY')) {
      return { rows: [{ count: rows.length }] as any, rowCount: 1 };
    }

    // Apply ORDER BY
    const orderMatch = sql.match(/ORDER BY\s+([a-zA-Z0-9_\.]+)\s*(ASC|DESC)?/i);
    if (orderMatch) {
      const field = orderMatch[1].split('.').pop()!;
      const isDesc = (orderMatch[2] || 'ASC').toUpperCase() === 'DESC';
      rows.sort((a, b) => {
        const valA = a[field] ?? 0;
        const valB = b[field] ?? 0;
        if (valA < valB) return isDesc ? 1 : -1;
        if (valA > valB) return isDesc ? -1 : 1;
        return 0;
      });
    }

    // Apply OFFSET & LIMIT
    const offsetMatch = sql.match(/OFFSET\s+(\$\d+|\d+)/i);
    let offset = 0;
    if (offsetMatch) {
      offset = offsetMatch[1].startsWith('$')
        ? Number(params[parseInt(offsetMatch[1].slice(1), 10) - 1])
        : parseInt(offsetMatch[1], 10);
    }

    const limitMatch = sql.match(/LIMIT\s+(\$\d+|\d+)/i);
    let limit = rows.length;
    if (limitMatch) {
      limit = limitMatch[1].startsWith('$')
        ? Number(params[parseInt(limitMatch[1].slice(1), 10) - 1])
        : parseInt(limitMatch[1], 10);
    }

    const sliced = rows.slice(offset, offset + limit);
    return { rows: sliced as T[], rowCount: sliced.length };
  }

  private handleInsert<T>(sql: string, params: any[]): QueryResult<T> {
    const match = sql.match(/INSERT INTO\s+([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)(?:\s+RETURNING|\s+ON CONFLICT|\s*;|\s*$)/i) ||
      sql.match(/INSERT INTO\s+([a-zA-Z0-9_]+)\s*\((.*?)\)\s*VALUES\s*\((.*?)\)/is);
    if (!match) return { rows: [], rowCount: 0 };

    const tableName = match[1].toLowerCase();
    const columns = match[2].split(',').map(c => c.trim().toLowerCase());
    const placeholders = match[3].split(',').map(p => p.trim());

    const table = this.tables.get(tableName) || [];
    const newRecord: Record<string, any> = {
      id: uuidv4(),
      created_at: new Date(),
      updated_at: new Date(),
      is_active: true,
      is_online: false,
      is_banned: false,
      is_admin: false,
      score: 0,
      kills: 0,
      deaths: 0,
      wins: 0,
      losses: 0,
      time_played_seconds: 0,
      custom_stats: {},
      details: {}
    };

    placeholders.forEach((ph, i) => {
      const col = columns[i];
      if (ph.startsWith('$')) {
        const paramIdx = parseInt(ph.slice(1), 10) - 1;
        newRecord[col] = params[paramIdx];
      } else if (ph.toUpperCase() === 'NOW()') {
        newRecord[col] = new Date();
      } else if (ph.toUpperCase() === 'TRUE') {
        newRecord[col] = true;
      } else if (ph.toUpperCase() === 'FALSE') {
        newRecord[col] = false;
      } else if (ph.toUpperCase() === 'DEFAULT' || ph.toLowerCase().includes('gen_random_uuid')) {
        if (!newRecord[col]) newRecord[col] = uuidv4();
      } else if (ph.includes('::jsonb')) {
        const cleaned = ph.replace(/::jsonb/gi, '').trim().replace(/^'|'$/g, '');
        try {
          newRecord[col] = JSON.parse(cleaned);
        } catch {
          newRecord[col] = {};
        }
      } else {
        newRecord[col] = ph.replace(/^'|'$/g, '');
      }
    });

    // Handle ON CONFLICT
    if (sql.toLowerCase().includes('on conflict')) {
      const conflictMatch = sql.match(/ON CONFLICT\s*\((.*?)\)\s*(DO UPDATE SET|DO NOTHING)(.*?)(RETURNING|$)/is);
      if (conflictMatch) {
        const conflictKey = conflictMatch[1].trim().toLowerCase();
        const action = conflictMatch[2].toUpperCase();
        const keyVal = newRecord[conflictKey];
        const existingIdx =
          keyVal == null || conflictKey.includes(',')
            ? -1
            : table.findIndex(r => r[conflictKey] === keyVal);
        if (existingIdx !== -1) {
          if (action === 'DO NOTHING') {
            return { rows: [], rowCount: 0 };
          }
          const updateSet = conflictMatch[3];
          this.applySetClause(updateSet, table[existingIdx], params, newRecord);
          return { rows: [table[existingIdx] as T], rowCount: 1 };
        }
      }
    }

    table.push(newRecord);
    this.tables.set(tableName, table);
    return { rows: [newRecord as T], rowCount: 1 };
  }

  private handleUpdate<T>(sql: string, params: any[]): QueryResult<T> {
    const tableMatch = sql.match(/UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+(.*?)\s+WHERE\s+(.*?)(RETURNING|$)/is);
    if (!tableMatch) return { rows: [], rowCount: 0 };

    const tableName = tableMatch[1].toLowerCase();
    const setClause = tableMatch[2];
    const whereClause = tableMatch[3];

    const table = this.tables.get(tableName) || [];
    const updatedRows: any[] = [];

    for (let i = 0; i < table.length; i++) {
      if (this.evaluateWhere(whereClause, table[i], params)) {
        const row = { ...table[i] };
        this.applySetClause(setClause, row, params);
        table[i] = row;
        updatedRows.push(row);
      }
    }

    return { rows: updatedRows as T[], rowCount: updatedRows.length };
  }

  private handleDelete<T>(sql: string, params: any[]): QueryResult<T> {
    const tableMatch = sql.match(/DELETE FROM\s+([a-zA-Z0-9_]+)\s+WHERE\s+(.*)/is);
    if (!tableMatch) return { rows: [], rowCount: 0 };

    const tableName = tableMatch[1].toLowerCase();
    const whereClause = tableMatch[2];

    const table = this.tables.get(tableName) || [];
    const remaining: any[] = [];
    let deletedCount = 0;

    for (const row of table) {
      if (this.evaluateWhere(whereClause, row, params)) {
        deletedCount++;
      } else {
        remaining.push(row);
      }
    }

    this.tables.set(tableName, remaining);
    return { rows: [], rowCount: deletedCount };
  }

  private evaluateWhere(whereClause: string, row: Record<string, any>, params: any[]): boolean {
    const conditions = whereClause.split(/\s+AND\s+/i);

    for (const cond of conditions) {
      let cleanCond = cond.trim();
      if (cleanCond.startsWith('(') && cleanCond.endsWith(')')) {
        cleanCond = cleanCond.slice(1, -1).trim();
      }

      // Check OR inside condition
      if (cleanCond.includes(' OR ')) {
        const orParts = cleanCond.split(/\s+OR\s+/i);
        const orPassed = orParts.some(p => this.evaluateSimpleCondition(p.trim(), row, params));
        if (!orPassed) return false;
        continue;
      }

      if (!this.evaluateSimpleCondition(cleanCond, row, params)) {
        return false;
      }
    }

    return true;
  }

  private evaluateSimpleCondition(cond: string, row: Record<string, any>, params: any[]): boolean {
    const anyMatch = cond.match(/(?:LOWER\()?\s*([a-zA-Z0-9_\.]+)\s*\)?\s*=\s*ANY\s*\(\s*(.*?)\s*\)/i);
    if (anyMatch) {
      const col = anyMatch[1].split('.').pop()!.toLowerCase();
      let rawVal = anyMatch[2].trim();
      let targetArr: any[] = [];
      if (rawVal.startsWith('$')) {
        const idx = parseInt(rawVal.replace(/[^\d]/g, ''), 10) - 1;
        targetArr = params[idx];
      }
      if (Array.isArray(targetArr)) {
        return targetArr.includes(row[col]);
      }
      return false;
    }

    const match = cond.match(/(?:LOWER\()?\s*([a-zA-Z0-9_\.]+)\s*\)?\s*(=|!=|<>|IS|ILIKE|LIKE|<|>|<=|>=)\s*(.*)/i);
    if (!match) return true;

    const col = match[1].split('.').pop()!.toLowerCase();
    const op = match[2].toUpperCase();
    let rawVal = match[3].trim();

    let isLower = cond.toLowerCase().startsWith('lower(');

    // Strip LOWER() wrapper on value if present
    const lowerValMatch = rawVal.match(/LOWER\((.*?)\)/i);
    if (lowerValMatch) {
      rawVal = lowerValMatch[1].trim();
      isLower = true;
    }

    // Strip UPPER() wrapper
    const upperValMatch = rawVal.match(/UPPER\((.*?)\)/i);
    if (upperValMatch) {
      rawVal = upperValMatch[1].trim();
    }

    let targetVal: any;
    if (rawVal.startsWith('$')) {
      const idx = parseInt(rawVal.replace(/[^\d]/g, ''), 10) - 1;
      targetVal = params[idx];
    } else if (rawVal.toLowerCase() === 'null') {
      targetVal = null;
    } else if (rawVal.toLowerCase() === 'true') {
      targetVal = true;
    } else if (rawVal.toLowerCase() === 'false') {
      targetVal = false;
    } else {
      targetVal = rawVal.replace(/^'|'$/g, '');
    }

    const rowVal = row[col];

    if (op === '=') {
      if (isLower && typeof rowVal === 'string' && typeof targetVal === 'string') {
        return rowVal.toLowerCase() === targetVal.toLowerCase();
      }
      if (typeof rowVal === 'boolean') {
        return Boolean(rowVal) === Boolean(targetVal);
      }
      return rowVal === targetVal;
    }
    if (op === '!=' || op === '<>') {
      return rowVal !== targetVal;
    }
    if (op === 'IS') {
      return rowVal === targetVal;
    }
    const isDateCompare =
      (rowVal instanceof Date || (typeof rowVal === 'string' && !isNaN(Date.parse(rowVal)))) &&
      (targetVal instanceof Date || (typeof targetVal === 'string' && !isNaN(Date.parse(targetVal))));

    const numRow = isDateCompare ? new Date(rowVal).getTime() : Number(rowVal);
    const numTarget = isDateCompare ? new Date(targetVal).getTime() : Number(targetVal);

    if (op === '<') {
      return numRow < numTarget;
    }
    if (op === '>') {
      return numRow > numTarget;
    }
    if (op === '<=') {
      return numRow <= numTarget;
    }
    if (op === '>=') {
      return numRow >= numTarget;
    }
    if (op === 'LIKE' || op === 'ILIKE') {
      const pattern = String(targetVal).replace(/%/g, '.*');
      return new RegExp(`^${pattern}$`, 'i').test(String(rowVal || ''));
    }

    return true;
  }

  private applySetClause(setClause: string, row: Record<string, any>, params: any[], excluded?: Record<string, any>): void {
    let clause = setClause.trim();
    let mergeCustom = false;
    const customIdx = clause.search(/custom_stats\s*=/i);
    if (customIdx >= 0 && /jsonb_object_agg/i.test(clause.slice(customIdx))) {
      mergeCustom = true;
      clause = clause.slice(0, customIdx).replace(/,\s*$/, '');
    }
    // Split on comma only outside parentheses
    const assignments: string[] = [];
    let current = '';
    let parenDepth = 0;
    for (let i = 0; i < clause.length; i++) {
      const char = clause[i];
      if (char === '(') parenDepth++;
      else if (char === ')') parenDepth--;
      if (char === ',' && parenDepth === 0) {
        assignments.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    if (current.trim()) assignments.push(current);

    for (const assign of assignments) {
      const parts = assign.split('=');
      if (parts.length !== 2) continue;
      const col = parts[0].trim().toLowerCase();
      const rhs = parts[1].trim();

      if (rhs.toUpperCase().startsWith('GREATEST(')) {
        const innerMatch = rhs.match(/GREATEST\((.*?)\)/i);
        if (innerMatch) {
          const args = innerMatch[1].split(',').map(a => a.trim());
          const vals = args.map(arg => {
            if (arg.startsWith('$')) {
              const idx = parseInt(arg.slice(1), 10) - 1;
              return Number(params[idx] || 0);
            }
            if (arg.toLowerCase() === col) {
              return Number(row[col] || 0);
            }
            return Number(arg || 0);
          });
          row[col] = Math.max(...vals);
        }
      } else if (rhs.startsWith('$')) {
        const idx = parseInt(rhs.slice(1), 10) - 1;
        row[col] = params[idx];
      } else if (rhs.toUpperCase() === 'NOW()') {
        row[col] = new Date();
      } else if (rhs.toLowerCase().includes('excluded.') && excluded) {
        const exclCol = rhs.split('excluded.')[1].split(/[,\s\)]/)[0].toLowerCase();
        row[col] = excluded[exclCol];
      } else if (rhs.includes('+')) {
        const plusParts = rhs.split('+');
        const incrementPh = plusParts[1].trim();
        const incVal = incrementPh.startsWith('$')
          ? Number(params[parseInt(incrementPh.slice(1), 10) - 1])
          : Number(incrementPh);
        row[col] = (Number(row[col]) || 0) + incVal;
      } else if (rhs.toLowerCase() === 'true') {
        row[col] = true;
      } else if (rhs.toLowerCase() === 'false') {
        row[col] = false;
      } else {
        row[col] = rhs.replace(/^'|'$/g, '');
      }
    }
    if (mergeCustom && excluded) {
      row.custom_stats = mergeNumericCustom(row.custom_stats, excluded.custom_stats);
    }
  }

  public async transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    return fn(this);
  }

  public async close(): Promise<void> {
    // no-op for in-memory
  }

  public isPostgres(): boolean {
    return false;
  }
}

function asJsonObject(value: any): Record<string, any> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  if (value && typeof value === 'object') return value;
  return {};
}

function mergeNumericCustom(current: any, incoming: any): Record<string, number> {
  const left = asJsonObject(current);
  const right = asJsonObject(incoming);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const out: Record<string, number> = {};
  for (const key of keys) {
    const a = Number(left[key] ?? 0);
    const b = Number(right[key] ?? 0);
    out[key] = (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);
  }
  return out;
}

let activeClient: DbClient | null = null;

/**
 * Gets or initializes the singleton database client.
 */
export async function getDbClient(): Promise<DbClient> {
  if (activeClient) {
    return activeClient;
  }

  const forceMemory = process.env.NODE_ENV === 'test' || process.env.USE_MEMORY_DB === 'true';

  if (!forceMemory && process.env.DATABASE_URL) {
    try {
      const pgClient = new PostgresDbClient(process.env.DATABASE_URL);
      await pgClient.query('SELECT 1');
      activeClient = pgClient;
      return activeClient;
    } catch (err: any) {
      console.warn(`[DB] PostgreSQL connection failed (${err.message}). Falling back to In-Memory DB.`);
    }
  }

  activeClient = new MemoryDbClient();
  return activeClient;
}

/**
 * Explicitly sets the active DbClient (e.g. for testing).
 */
export function setDbClient(client: DbClient): void {
  activeClient = client;
}

/**
 * Closes the active database client.
 */
export async function closeDbClient(): Promise<void> {
  if (activeClient) {
    await activeClient.close();
    activeClient = null;
  }
}
