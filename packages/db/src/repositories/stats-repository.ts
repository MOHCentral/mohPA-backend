/**
 * mohPA Stats, Match History & Audit Repository
 */

import { PersonaStats, MatchHistory, AuditLog } from '@mohpa/shared';
import { DbClient } from '../client.js';

export interface LeaderboardEntry extends PersonaStats {
  personaName: string;
  name: string;
  userId: string;
  gameSlug: string;
}

export interface IncrementStatsDto {
  score?: number;
  kills?: number;
  deaths?: number;
  wins?: number;
  losses?: number;
  timePlayedSeconds?: number;
  customStats?: Record<string, any>;
}

export interface CreateMatchHistoryDto {
  serverId?: string | null;
  gameSlug: string;
  mapName: string;
  gameMode: string;
  durationSeconds?: number;
  winnerTeam?: number | null;
  details?: Record<string, any>;
  statsMatchKey?: string | null;
}

export interface MatchPlayerIncrement {
  personaId: string;
  kills?: number;
  deaths?: number;
  score?: number;
  timePlayedSeconds?: number;
  customStats?: Record<string, number>;
}

export interface CreateAuditLogDto {
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  details?: Record<string, any>;
}

export class StatsRepository {
  constructor(private db: DbClient) {}

  public async getStats(personaId: string): Promise<PersonaStats | null> {
    const sql = 'SELECT * FROM persona_stats WHERE persona_id = $1 LIMIT 1';
    const result = await this.db.query(sql, [personaId]);
    if (result.rows.length === 0) return null;
    return this.mapStats(result.rows[0]);
  }

  public async getStatsBatch(personaIds: string[]): Promise<Map<string, PersonaStats>> {
    if (personaIds.length === 0) return new Map();
    const sql = 'SELECT * FROM persona_stats WHERE persona_id = ANY($1)';
    const result = await this.db.query(sql, [personaIds]);
    const map = new Map<string, PersonaStats>();
    for (const row of result.rows) {
      const stats = this.mapStats(row);
      map.set(stats.personaId, stats);
    }
    return map;
  }

  public async upsertStats(stats: Partial<PersonaStats> & { personaId: string }): Promise<PersonaStats> {
    const sql = `
      INSERT INTO persona_stats (
        persona_id, score, kills, deaths, wins, losses, time_played_seconds, custom_stats
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (persona_id) DO UPDATE SET
        score = COALESCE(EXCLUDED.score, persona_stats.score),
        kills = COALESCE(EXCLUDED.kills, persona_stats.kills),
        deaths = COALESCE(EXCLUDED.deaths, persona_stats.deaths),
        wins = COALESCE(EXCLUDED.wins, persona_stats.wins),
        losses = COALESCE(EXCLUDED.losses, persona_stats.losses),
        time_played_seconds = COALESCE(EXCLUDED.time_played_seconds, persona_stats.time_played_seconds),
        custom_stats = COALESCE(EXCLUDED.custom_stats, persona_stats.custom_stats)
      RETURNING *
    `;
    const params = [
      stats.personaId,
      stats.score || 0,
      stats.kills || 0,
      stats.deaths || 0,
      stats.wins || 0,
      stats.losses || 0,
      stats.timePlayedSeconds || 0,
      JSON.stringify(stats.customStats || {})
    ];

    const result = await this.db.query(sql, params);
    return this.mapStats(result.rows[0]);
  }

  public async incrementStats(personaId: string, increments: IncrementStatsDto): Promise<PersonaStats> {
    const sql = `
      INSERT INTO persona_stats (
        persona_id, score, kills, deaths, wins, losses, time_played_seconds, custom_stats
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (persona_id) DO UPDATE SET
        score = persona_stats.score + $2,
        kills = persona_stats.kills + $3,
        deaths = persona_stats.deaths + $4,
        wins = persona_stats.wins + $5,
        losses = persona_stats.losses + $6,
        time_played_seconds = persona_stats.time_played_seconds + $7,
        custom_stats = (
          SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
          FROM (
            SELECT key, to_jsonb(COALESCE((persona_stats.custom_stats->>key)::bigint, 0)
                               + COALESCE((EXCLUDED.custom_stats->>key)::bigint, 0)) AS value
            FROM (
              SELECT jsonb_object_keys(persona_stats.custom_stats) AS key
              UNION
              SELECT jsonb_object_keys(EXCLUDED.custom_stats)
            ) keys
          ) summed
        )
      RETURNING *
    `;
    const params = [
      personaId,
      increments.score || 0,
      increments.kills || 0,
      increments.deaths || 0,
      increments.wins || 0,
      increments.losses || 0,
      increments.timePlayedSeconds || 0,
      JSON.stringify(increments.customStats || {})
    ];

    const result = await this.db.query(sql, params);
    return this.mapStats(result.rows[0]);
  }

  public async getLeaderboard(
    gameSlug: string,
    sortBy: 'score' | 'kills' | 'wins' | 'playtime' = 'score',
    limit = 50,
    offset = 0
  ): Promise<LeaderboardEntry[]> {
    const validSorts: Record<string, string> = {
      score: 'score DESC, u.created_at ASC',
      kills: 'kills DESC, u.created_at ASC',
      wins: 'wins DESC, u.created_at ASC',
      playtime: 'time_played_seconds DESC, u.created_at ASC'
    };
    const orderClause = validSorts[sortBy] || validSorts.score;

    const sql = `
      SELECT 
        COALESCE(p.id, u.id) as persona_id,
        COALESCE(ps.score, 0) as score,
        COALESCE(ps.kills, 0) as kills,
        COALESCE(ps.deaths, 0) as deaths,
        COALESCE(ps.wins, 0) as wins,
        COALESCE(ps.losses, 0) as losses,
        COALESCE(ps.time_played_seconds, 0) as time_played_seconds,
        COALESCE(ps.custom_stats, '{}'::jsonb) as custom_stats,
        COALESCE(p.name, u.username) as persona_name,
        COALESCE(p.name, u.username) as name,
        u.id as user_id,
        COALESCE(p.game_slug, $1) as game_slug
      FROM users u
      LEFT JOIN personas p ON p.user_id = u.id AND p.game_slug = $1 AND p.is_active = TRUE
      LEFT JOIN persona_stats ps ON ps.persona_id = p.id
      WHERE u.is_banned = FALSE
      ORDER BY ${orderClause}
      LIMIT $2 OFFSET $3
    `;

    const result = await this.db.query(sql, [gameSlug.toLowerCase(), limit, offset]);
    return result.rows.map(r => ({
      ...this.mapStats(r),
      personaName: r.persona_name,
      name: r.persona_name,
      userId: r.user_id,
      gameSlug: r.game_slug
    }));
  }

  public async recordMatch(data: CreateMatchHistoryDto): Promise<MatchHistory | null> {
    const sql = `
      INSERT INTO match_history (
        server_id, game_slug, map_name, game_mode, duration_seconds, winner_team, details, stats_match_key
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (stats_match_key) DO NOTHING
      RETURNING *
    `;
    const params = [
      data.serverId || null,
      data.gameSlug.toLowerCase(),
      data.mapName,
      data.gameMode,
      data.durationSeconds || 0,
      data.winnerTeam !== undefined ? data.winnerTeam : null,
      JSON.stringify(data.details || {}),
      data.statsMatchKey || null
    ];

    const result = await this.db.query(sql, params);
    if (result.rows.length === 0) return null;
    return this.mapMatch(result.rows[0]);
  }

  public async applyMatchReport(input: {
    statsMatchKey: string;
    match: CreateMatchHistoryDto;
    players: MatchPlayerIncrement[];
  }): Promise<{ inserted: boolean; match: MatchHistory | null; updatedStats: PersonaStats[] }> {
    return this.db.transaction(async (tx) => {
      const repo = new StatsRepository(tx);
      const match = await repo.recordMatch({ ...input.match, statsMatchKey: input.statsMatchKey });
      if (!match) return { inserted: false, match: null, updatedStats: [] };
      const updatedStats: PersonaStats[] = [];
      for (const player of input.players) {
        if (!player.personaId) continue;
        updatedStats.push(await repo.incrementStats(player.personaId, {
          score: player.score || 0,
          kills: player.kills || 0,
          deaths: player.deaths || 0,
          timePlayedSeconds: player.timePlayedSeconds || 0,
          customStats: player.customStats || {}
        }));
      }
      return { inserted: true, match, updatedStats };
    });
  }

  public async writeCustomStats(
    personaId: string,
    replace: boolean,
    data: Record<string, number>
  ): Promise<void> {
    const ints: Record<string, number> = {};
    for (const [key, value] of Object.entries(data || {})) {
      if (!key) continue;
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      ints[key] = Math.trunc(n);
    }
    if (!replace) {
      await this.incrementStats(personaId, { customStats: ints });
      return;
    }
    const json = JSON.stringify(ints);
    const updated = await this.db.query(
      'UPDATE persona_stats SET custom_stats = $2 WHERE persona_id = $1',
      [personaId, json]
    );
    if ((updated.rowCount || 0) === 0) {
      await this.db.query(
        `INSERT INTO persona_stats (
          persona_id, score, kills, deaths, wins, losses, time_played_seconds, custom_stats
        ) VALUES ($1, 0, 0, 0, 0, 0, 0, $2)`,
        [personaId, json]
      );
    }
  }

  public async getMatchHistory(gameSlug?: string, limit = 20): Promise<MatchHistory[]> {
    const whereSql = gameSlug ? 'WHERE game_slug = $1' : '';
    const params = gameSlug ? [gameSlug.toLowerCase(), limit] : [limit];
    const limitParam = gameSlug ? '$2' : '$1';

    const sql = `
      SELECT * FROM match_history
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ${limitParam}
    `;

    const result = await this.db.query(sql, params);
    return result.rows.map(r => this.mapMatch(r));
  }

  public async logAudit(data: CreateAuditLogDto): Promise<AuditLog> {
    const sql = `
      INSERT INTO audit_logs (actor_id, action, target_type, target_id, details)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const params = [
      data.actorId || null,
      data.action,
      data.targetType,
      data.targetId || null,
      JSON.stringify(data.details || {})
    ];

    const result = await this.db.query(sql, params);
    return this.mapAudit(result.rows[0]);
  }

  public async getAuditLogs(limit = 50, offset = 0): Promise<AuditLog[]> {
    const sql = 'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2';
    const result = await this.db.query(sql, [limit, offset]);
    return result.rows.map(r => this.mapAudit(r));
  }

  private parseJsonField(val: any): Record<string, any> {
    if (typeof val === 'object' && val !== null) return val;
    if (typeof val === 'string') {
      try {
        const cleaned = val.replace(/::jsonb/gi, '').trim().replace(/^'|'$/g, '');
        return JSON.parse(cleaned);
      } catch {
        return {};
      }
    }
    return {};
  }

  private mapStats(row: any): PersonaStats {
    return {
      personaId: row.persona_id,
      score: Number(row.score || 0),
      kills: Number(row.kills || 0),
      deaths: Number(row.deaths || 0),
      wins: Number(row.wins || 0),
      losses: Number(row.losses || 0),
      timePlayedSeconds: Number(row.time_played_seconds || 0),
      customStats: this.parseJsonField(row.custom_stats)
    };
  }

  private mapMatch(row: any): MatchHistory {
    return {
      id: row.id,
      serverId: row.server_id,
      gameSlug: row.game_slug,
      mapName: row.map_name,
      gameMode: row.game_mode,
      durationSeconds: Number(row.duration_seconds || 0),
      winnerTeam: row.winner_team !== null ? Number(row.winner_team) : null,
      details: this.parseJsonField(row.details),
      createdAt: new Date(row.created_at)
    };
  }

  private mapAudit(row: any): AuditLog {
    return {
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      details: this.parseJsonField(row.details),
      createdAt: new Date(row.created_at)
    };
  }
}

