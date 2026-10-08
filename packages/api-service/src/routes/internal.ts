/**
 * mohPA Internal IPC Routes (/internal)
 * Secured with X-Internal-Key for direct communication with fesl-engine.
 */

import { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';

export const internalRoutes: FastifyPluginAsync = async (fastify) => {
  // Apply internal authentication to all internal endpoints
  fastify.addHook('preHandler', fastify.authenticateInternal);

  // Validate credentials for FESL Login / NuLogin
  fastify.post('/auth/validate', async (request, reply) => {
    const { identifier, username, email, password, gameSlug } = request.body as any || {};
    const loginId = (identifier || username || email || '').trim();

    if (!loginId || !password) {
      return reply.code(400).send({ valid: false, error: 'Identifier and password required' });
    }

    const user = await fastify.userRepo.findByUsernameOrEmail(loginId);
    if (!user) {
      return reply.code(401).send({ valid: false, error: 'Invalid credentials' });
    }

    if (user.isBanned) {
      return reply.code(403).send({ valid: false, error: 'Account is banned' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return reply.code(401).send({ valid: false, error: 'Invalid credentials' });
    }

    // Fetch personas for the game if specified
    const personas = gameSlug
      ? await fastify.personaRepo.findByUserIdAndGame(user.id, gameSlug)
      : await fastify.personaRepo.findByUserId(user.id);

    return reply.send({
      valid: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        countryCode: user.countryCode,
        dob: user.dob,
        isAdmin: user.isAdmin
      },
      personas
    });
  });

  // Get persona list for NuGetPersonas / GetPersonas
  fastify.get('/personas/list', async (request, reply) => {
    const { userId, gameSlug } = request.query as any || {};

    if (!userId) {
      return reply.code(400).send({ error: 'userId is required' });
    }

    let personas = gameSlug
      ? await fastify.personaRepo.findByUserIdAndGame(userId, gameSlug)
      : await fastify.personaRepo.findByUserId(userId);

    // Fallback: If user has no active personas yet, provide default persona using their username
    if (personas.length === 0) {
      const user = await fastify.userRepo.findById(userId);
      if (user) {
        personas = [{
          id: user.id,
          userId: user.id,
          gameSlug: gameSlug || 'mohpa',
          name: user.username,
          isActive: !user.isBanned,
          createdAt: user.createdAt
        }];
      }
    }

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

  // Lookup persona by soldier name or GameSpy profile id
  fastify.get('/personas/lookup', async (request, reply) => {
    const { name, gameSlug, gsProfileId } = request.query as any || {};
    const hasProfile = gsProfileId != null && gsProfileId !== '';
    if (!name && !hasProfile) {
      return reply.code(400).send({ error: 'name is required' });
    }

    let persona = null;
    if (hasProfile) {
      persona = await fastify.personaRepo.findByGsProfileId(Number(gsProfileId));
    } else if (gameSlug) {
      persona = await fastify.personaRepo.findByNameAndGame(name, gameSlug);
    } else {
      persona = await fastify.personaRepo.findByName(name);
    }

    // Fallback: If not found, check registered user
    if (!persona && name && !hasProfile) {
      const user = await fastify.userRepo.findByUsername(name);
      if (user) {
        persona = {
          id: user.id,
          userId: user.id,
          gameSlug: gameSlug || 'mohpa',
          name: user.username,
          isActive: !user.isBanned,
          createdAt: user.createdAt
        };
      }
    }

    if (!persona) {
      return reply.code(404).send({ error: 'Persona not found' });
    }

    const stats = await fastify.statsRepo.getStats(persona.id);
    return reply.send({
      ...persona,
      stats: stats || {
        personaId: persona.id,
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

  fastify.post('/personas/gs-profile', async (request, reply) => {
    const { name, gameSlug, gsProfileId } = request.body as any || {};
    if (!name || gsProfileId == null) {
      return reply.code(400).send({ error: 'name and gsProfileId are required' });
    }
    const persona = await fastify.personaRepo.findByNameAndGame(String(name), gameSlug || 'mohpa');
    if (!persona) return reply.send({ stored: false });
    await fastify.personaRepo.setGsProfileId(persona.id, Number(gsProfileId));
    return reply.send({ stored: true, personaId: persona.id });
  });

  // Get user details by ID
  fastify.get('/users/:id', async (request, reply) => {
    const { id } = request.params as any;
    const user = await fastify.userRepo.findById(id);
    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }
    return reply.send({
      id: user.id,
      username: user.username,
      email: user.email,
      countryCode: user.countryCode,
      dob: user.dob,
      isAdmin: user.isAdmin,
      isBanned: user.isBanned,
    });
  });

  // Update user demographic details by ID
  fastify.put('/users/:id', async (request, reply) => {
    const { id } = request.params as any;
    const updates = request.body as any || {};
    const user = await fastify.userRepo.update(id, updates);
    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }
    return reply.send(user);
  });

  // Post-match telemetry reporting (dedicated-server snapshot or legacy single persona)
  fastify.post('/stats/report', async (request, reply) => {
    const body = request.body as any || {};
    if (body.statsMatchKey) {
      const match = body.match || {};
      const players = Array.isArray(body.players) ? body.players : [];
      const result = await fastify.statsRepo.applyMatchReport({
        statsMatchKey: String(body.statsMatchKey),
        match: {
          serverId: match.serverId || null,
          gameSlug: match.gameSlug || 'mohpa',
          mapName: match.mapName || 'unknown',
          gameMode: match.gameMode || 'unknown',
          durationSeconds: Number(match.durationSeconds || 0),
          winnerTeam: match.winnerTeam !== undefined ? Number(match.winnerTeam) : null,
          details: match.details || {}
        },
        players: players.filter((player: any) => player && player.personaId).map((player: any) => ({
          personaId: String(player.personaId),
          score: Number(player.score || 0),
          kills: Number(player.kills || 0),
          deaths: Number(player.deaths || 0),
          timePlayedSeconds: Number(player.timePlayedSeconds || 0),
          customStats: player.customStats || {}
        }))
      });
      return reply.send({
        success: true,
        duplicate: !result.inserted,
        updatedStats: result.updatedStats,
        recordedMatch: result.match
      });
    }

    const {
      personaId,
      score = 0,
      kills = 0,
      deaths = 0,
      wins = 0,
      losses = 0,
      timePlayedSeconds = 0,
      customStats = {},
      match
    } = body;

    if (!personaId) {
      return reply.code(400).send({ error: 'personaId is required' });
    }

    const updatedStats = await fastify.statsRepo.incrementStats(personaId, {
      score: Number(score),
      kills: Number(kills),
      deaths: Number(deaths),
      wins: Number(wins),
      losses: Number(losses),
      timePlayedSeconds: Number(timePlayedSeconds),
      customStats
    });

    let recordedMatch = null;
    if (match && match.gameSlug && match.mapName) {
      recordedMatch = await fastify.statsRepo.recordMatch({
        serverId: match.serverId || null,
        gameSlug: match.gameSlug,
        mapName: match.mapName,
        gameMode: match.gameMode || 'Conquest',
        durationSeconds: Number(match.durationSeconds || 0),
        winnerTeam: match.winnerTeam !== undefined ? Number(match.winnerTeam) : null,
        details: match.details || {}
      });
    }

    return reply.send({
      success: true,
      updatedStats,
      recordedMatch
    });
  });

  fastify.post('/stats/persist', async (request, reply) => {
    const body = request.body as any || {};
    const kv = Number(body.kv ?? 1);
    const data = body.data || {};
    let persona = null;
    if (body.personaId) {
      persona = await fastify.personaRepo.findById(String(body.personaId));
    } else if (body.gsProfileId != null && body.gsProfileId !== '') {
      persona = await fastify.personaRepo.findByGsProfileId(Number(body.gsProfileId));
    } else if (body.name) {
      persona = await fastify.personaRepo.findByNameAndGame(String(body.name), body.gameSlug || 'mohpa');
    }
    if (!persona) return reply.send({ stored: false });
    await fastify.statsRepo.writeCustomStats(persona.id, kv === 0, data);
    return reply.send({ stored: true });
  });

  // Server lookup by IP & port or secret key
  fastify.get('/servers/lookup', async (request, reply) => {
    const { ip, port, secretKey } = request.query as any || {};

    let server = null;
    if (secretKey) {
      server = await fastify.serverRepo.findBySecretKey(secretKey);
    } else if (ip && port) {
      server = await fastify.serverRepo.findByIpAndPort(ip, Number(port));
    }

    if (!server) {
      return reply.code(404).send({ error: 'Server not found' });
    }

    return reply.send({ server });
  });

  // Live packet ingestion for WebSocket inspector
  fastify.post('/events/packet', async (request, reply) => {
    const event = request.body as any;
    if (event && event.protocol && event.subsystemOrCommand) {
      fastify.inspectorHub.broadcastPacket({
        id: event.id || crypto.randomUUID(),
        timestamp: event.timestamp || Date.now(),
        protocol: event.protocol,
        direction: event.direction || 'INCOMING',
        clientIp: event.clientIp || '127.0.0.1',
        clientPort: Number(event.clientPort || 0),
        subsystemOrCommand: event.subsystemOrCommand,
        subtypeOrTxn: event.subtypeOrTxn || '',
        length: Number(event.length || 0),
        payload: event.payload || {},
        rawHex: event.rawHex
      });
    }

    return reply.send({ received: true });
  });
};
