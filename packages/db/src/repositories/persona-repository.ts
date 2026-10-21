/**
 * mohPA Persona Repository
 */

import { Persona } from '@mohpa/shared';
import { DbClient } from '../client.js';

export interface CreatePersonaData {
  userId: string;
  gameSlug: string;
  name: string;
}

export class PersonaRepository {
  constructor(private db: DbClient) {}

  public async create(data: CreatePersonaData): Promise<Persona> {
    const sql = `
      INSERT INTO personas (user_id, game_slug, name, is_active)
      VALUES ($1, $2, $3, TRUE)
      RETURNING *
    `;
    const result = await this.db.query(sql, [data.userId, data.gameSlug.toLowerCase(), data.name]);
    const persona = this.mapPersona(result.rows[0]);

    // Automatically initialize persona_stats
    await this.db.query(
      `INSERT INTO persona_stats (persona_id, score, kills, deaths, wins, losses, time_played_seconds, custom_stats)
       VALUES ($1, 0, 0, 0, 0, 0, 0, '{}'::jsonb)
       ON CONFLICT (persona_id) DO NOTHING`,
      [persona.id]
    );

    return persona;
  }

  public async findById(id: string): Promise<Persona | null> {
    const sql = 'SELECT * FROM personas WHERE id = $1 LIMIT 1';
    const result = await this.db.query(sql, [id]);
    if (result.rows.length === 0) return null;
    return this.mapPersona(result.rows[0]);
  }

  public async findByNameAndGame(name: string, gameSlug: string): Promise<Persona | null> {
    const sql = 'SELECT * FROM personas WHERE LOWER(name) = LOWER($1) AND game_slug = $2 LIMIT 1';
    const result = await this.db.query(sql, [name, gameSlug.toLowerCase()]);
    if (result.rows.length === 0) return null;
    return this.mapPersona(result.rows[0]);
  }

  public async findByNameAndAnyGame(name: string, gameSlugs: string[]): Promise<Persona | null> {
    const sql = 'SELECT * FROM personas WHERE LOWER(name) = LOWER($1) AND game_slug = ANY($2) LIMIT 1';
    const result = await this.db.query(sql, [name, gameSlugs.map(s => s.toLowerCase())]);
    if (result.rows.length === 0) return null;
    return this.mapPersona(result.rows[0]);
  }

  public async findByGsProfileId(gsProfileId: number): Promise<Persona | null> {
    const sql = 'SELECT * FROM personas WHERE gs_profile_id = $1 LIMIT 1';
    const result = await this.db.query(sql, [gsProfileId]);
    if (result.rows.length === 0) return null;
    return this.mapPersona(result.rows[0]);
  }

  public async setGsProfileId(personaId: string, gsProfileId: number): Promise<void> {
    await this.db.query(
      'UPDATE personas SET gs_profile_id = NULL WHERE gs_profile_id = $1 AND id <> $2',
      [gsProfileId, personaId]
    );
    await this.db.query(
      'UPDATE personas SET gs_profile_id = $1 WHERE id = $2',
      [gsProfileId, personaId]
    );
  }

  public async findByName(name: string): Promise<Persona | null> {
    const sql = 'SELECT * FROM personas WHERE LOWER(name) = LOWER($1) LIMIT 1';
    const result = await this.db.query(sql, [name]);
    if (result.rows.length === 0) return null;
    return this.mapPersona(result.rows[0]);
  }

  public async findByUserIdAndGame(userId: string, gameSlug: string): Promise<Persona[]> {
    const sql = 'SELECT * FROM personas WHERE user_id = $1 AND game_slug = $2 AND is_active = TRUE ORDER BY created_at ASC';
    const result = await this.db.query(sql, [userId, gameSlug.toLowerCase()]);
    return result.rows.map(r => this.mapPersona(r));
  }

  public async findByUserId(userId: string): Promise<Persona[]> {
    const sql = 'SELECT * FROM personas WHERE user_id = $1 AND is_active = TRUE ORDER BY created_at ASC';
    const result = await this.db.query(sql, [userId]);
    return result.rows.map(r => this.mapPersona(r));
  }

  public async countByUserIdAndGame(userId: string, gameSlug: string): Promise<number> {
    const sql = 'SELECT COUNT(*) as count FROM personas WHERE user_id = $1 AND game_slug = $2 AND is_active = TRUE';
    const result = await this.db.query(sql, [userId, gameSlug.toLowerCase()]);
    return parseInt(result.rows[0]?.count || '0', 10);
  }

  public async deactivate(id: string): Promise<boolean> {
    const sql = 'UPDATE personas SET is_active = FALSE WHERE id = $1 RETURNING id';
    const result = await this.db.query(sql, [id]);
    return result.rowCount > 0;
  }

  public async delete(id: string): Promise<boolean> {
    const sql = 'DELETE FROM personas WHERE id = $1';
    const result = await this.db.query(sql, [id]);
    return result.rowCount > 0;
  }

  private mapPersona(row: any): Persona {
    return {
      id: row.id,
      userId: row.user_id,
      gameSlug: row.game_slug,
      name: row.name,
      isActive: Boolean(row.is_active),
      createdAt: new Date(row.created_at)
    };
  }
}
