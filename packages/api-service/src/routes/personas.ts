/**
 * mohPA Personas REST Routes (/api/v1/personas)
 */

import { FastifyPluginAsync } from 'fastify';
import { getGameConfig } from '@mohpa/shared';

export const personaRoutes: FastifyPluginAsync = async (fastify) => {
  // List personas owned by the authenticated user
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const userId = (request.user as any).id;
    const { game_slug } = request.query as any || {};

    const personas = game_slug
      ? await fastify.personaRepo.findByUserIdAndGame(userId, game_slug)
      : await fastify.personaRepo.findByUserId(userId);

    // Attach stats summary for each persona
    const personaIds = personas.map(p => p.id);
    const statsMap = await fastify.statsRepo.getStatsBatch(personaIds);
    const enriched = personas.map((p) => {
      const stats = statsMap.get(p.id);
      return {
        ...p,
        stats: stats || { score: 0, kills: 0, deaths: 0, wins: 0, losses: 0, timePlayedSeconds: 0 }
      };
    });

    return reply.send({ personas: enriched });
  });

  // Create new persona
  fastify.post('/', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const userId = (request.user as any).id;
    const { gameSlug, name } = request.body as any || {};

    if (!gameSlug || typeof gameSlug !== 'string') {
      return reply.code(400).send({ error: 'gameSlug is required' });
    }

    const cleanSlug = gameSlug.toLowerCase().trim();
    const config = getGameConfig(cleanSlug);
    if (!config) {
      return reply.code(400).send({ error: `Unknown game slug: ${gameSlug}` });
    }

    if (!name || typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 24) {
      return reply.code(400).send({ error: 'Persona name must be between 3 and 24 characters' });
    }

    const cleanName = name.trim();

    // Check allowed characters: letters, numbers, hyphens, underscores, brackets
    if (!/^[a-zA-Z0-9_\-\[\]]+$/.test(cleanName)) {
      return reply.code(400).send({ error: 'Persona name contains invalid characters' });
    }

    // Check user's persona limit for this game
    const currentCount = await fastify.personaRepo.countByUserIdAndGame(userId, cleanSlug);
    if (currentCount >= config.maxPersonasPerUser) {
      return reply.code(400).send({
        error: `Maximum limit of ${config.maxPersonasPerUser} personas reached for ${config.name}`
      });
    }

    // Check name availability within this game
    const existing = await fastify.personaRepo.findByNameAndGame(cleanName, cleanSlug);
    if (existing) {
      return reply.code(409).send({ error: 'Persona name is already taken for this game' });
    }

    const persona = await fastify.personaRepo.create({
      userId,
      gameSlug: cleanSlug,
      name: cleanName
    });

    return reply.code(201).send({ persona });
  });

  // Delete / deactivate persona
  fastify.delete('/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const userId = (request.user as any).id;
    const isAdmin = Boolean((request.user as any).isAdmin);
    const { id } = request.params as any;

    const persona = await fastify.personaRepo.findById(id);
    if (!persona) {
      return reply.code(404).send({ error: 'Persona not found' });
    }

    if (persona.userId !== userId && !isAdmin) {
      return reply.code(403).send({ error: 'Forbidden: You do not own this persona' });
    }

    await fastify.personaRepo.delete(id);
    return reply.send({ success: true, message: 'Persona deleted successfully' });
  });

  // Get persona in-depth stats
  fastify.get('/:id/stats', async (request, reply) => {
    const { id } = request.params as any;
    const persona = await fastify.personaRepo.findById(id);
    if (!persona) {
      return reply.code(404).send({ error: 'Persona not found' });
    }

    const stats = await fastify.statsRepo.getStats(id);
    return reply.send({
      persona,
      stats: stats || {
        personaId: id,
        score: 0,
        kills: 0,
        deaths: 0,
        wins: 0,
        losses: 0,
        timePlayedSeconds: 0,
        customStats: {}
      }
    });
  });
};
