/**
 * mohPA Stats & Leaderboards REST Routes (/api/v1/stats)
 */

import { FastifyPluginAsync } from 'fastify';
import { getGameConfig, listGameConfigs, GameConfig } from '@mohpa/shared';

export const statsRoutes: FastifyPluginAsync = async (fastify) => {
  // Leaderboard for a game
  fastify.get('/leaderboard/:game_slug', async (request, reply) => {
    const { game_slug } = request.params as any;
    const query = request.query as any || {};

    const config = getGameConfig(game_slug);
    if (!config) {
      return reply.code(400).send({ error: `Unknown game slug: ${game_slug}` });
    }

    const sort = (query.sort || 'score') as 'score' | 'kills' | 'wins' | 'playtime';
    const limit = query.limit ? parseInt(query.limit, 10) : 100;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;

    const leaderboard = await fastify.statsRepo.getLeaderboard(config.slug, sort, limit, offset);

    return reply.send({
      gameSlug: config.slug,
      gameName: config.name,
      sortBy: sort,
      limit,
      offset,
      count: leaderboard.length,
      leaderboard
    });
  });

  // Public player / persona search lookup
  fastify.get('/players/:name', async (request, reply) => {
    const { name } = request.params as any;
    const query = request.query as any || {};
    const gameSlug = query.game_slug || query.gameSlug;

    let persona = null;
    if (gameSlug) {
      persona = await fastify.personaRepo.findByNameAndGame(name, gameSlug);
    } else {
      // Find across configured games
      const allGames = listGameConfigs().map((g) => g.slug);
      persona = await fastify.personaRepo.findByNameAndAnyGame(name, allGames);
    }

    // Fallback: If not found in personas, check if registered user exists by username
    if (!persona) {
      const user = await fastify.userRepo.findByUsername(name);
      if (user) {
        const config = getGameConfig(gameSlug || 'mohpa') || listGameConfigs()[0];
        persona = {
          id: user.id,
          userId: user.id,
          gameSlug: config.slug,
          name: user.username,
          isActive: !user.isBanned,
          createdAt: user.createdAt
        };
      }
    }

    if (!persona) {
      return reply.code(404).send({ error: `Player '${name}' not found` });
    }

    const stats = await fastify.statsRepo.getStats(persona.id);
    let finalStats = stats || {
      personaId: persona.id,
      score: 0,
      kills: 0,
      deaths: 0,
      wins: 0,
      losses: 0,
      timePlayedSeconds: 0,
      customStats: {}
    };

    // Aggregate any sessions recorded for this player
    try {
      const sessRes = await fastify.db.query(
        `SELECT duration_seconds, score, kills, deaths FROM server_player_sessions WHERE LOWER(player_name) = LOWER($1)`,
        [persona.name]
      );
      if (sessRes.rows && sessRes.rows.length > 0) {
        let sTime = 0;
        let sScore = 0;
        let sKills = 0;
        let sDeaths = 0;
        for (const row of sessRes.rows) {
          sTime += Number(row.duration_seconds || 0);
          sScore = Math.max(sScore, Number(row.score || 0));
          sKills += Number(row.kills || 0);
          sDeaths += Number(row.deaths || 0);
        }

        finalStats = {
          ...finalStats,
          timePlayedSeconds: Math.max(finalStats.timePlayedSeconds || 0, sTime),
          score: Math.max(finalStats.score || 0, sScore),
          kills: Math.max(finalStats.kills || 0, sKills),
          deaths: Math.max(finalStats.deaths || 0, sDeaths),
        };
      }
    } catch {
      // Ignore if session query fails
    }

    return reply.send({
      persona,
      stats: finalStats
    });
  });

  // Recent match history for game
  fastify.get('/matches/:game_slug', async (request, reply) => {
    const { game_slug } = request.params as any;
    const query = request.query as any || {};
    const limit = query.limit ? parseInt(query.limit, 10) : 20;

    const config = getGameConfig(game_slug);
    if (!config) {
      return reply.code(400).send({ error: `Unknown game slug: ${game_slug}` });
    }

    const matches = await fastify.statsRepo.getMatchHistory(config.slug, limit);
    return reply.send({
      gameSlug: config.slug,
      count: matches.length,
      matches
    });
  });
};
