/**
 * mohPA Fastify Server Setup
 */

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import dotenv from 'dotenv';

import {
  DbClient,
  UserRepository,
  PersonaRepository,
  EntitlementRepository,
  GameServerRepository,
  StatsRepository,
  ServerHistoryRepository,
  getDbClient
} from '@mohpa/db';

import { authRoutes } from './routes/auth.js';
import { personaRoutes } from './routes/personas.js';
import { entitlementRoutes } from './routes/entitlements.js';
import { serverRoutes } from './routes/servers.js';
import { statsRoutes } from './routes/stats.js';
import { adminRoutes } from './routes/admin.js';
import { internalRoutes } from './routes/internal.js';
import { newsRoutes } from './routes/news.js';
import { InspectorHub, getInspectorHub } from './websocket/inspector.js';

dotenv.config();

declare module 'fastify' {
  interface FastifyInstance {
    db: DbClient;
    userRepo: UserRepository;
    personaRepo: PersonaRepository;
    entitlementRepo: EntitlementRepository;
    serverRepo: GameServerRepository;
    statsRepo: StatsRepository;
    serverHistoryRepo: ServerHistoryRepository;
    inspectorHub: InspectorHub;
    turnstileSecret: string;
    turnstileRequired: boolean;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateInternal: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface ServerOptions {
  db?: DbClient;
  jwtSecret?: string;
  internalApiKey?: string;
  turnstileSecret?: string;
  turnstileRequired?: boolean;
  logger?: boolean;
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const server = Fastify({
    logger: options.logger ?? false,
    trustProxy: true
  });

  const dbClient = options.db || (await getDbClient());
  const isTest = process.env.NODE_ENV === 'test';

  const jwtSecret = options.jwtSecret || process.env.JWT_SECRET || (isTest ? 'test-jwt-secret' : undefined);
  if (!jwtSecret) {
    throw new Error('JWT_SECRET must be set in environment variables');
  }

  const internalApiKey = options.internalApiKey || process.env.INTERNAL_API_KEY || (isTest ? 'test-internal-api-key' : undefined);
  if (!internalApiKey) {
    throw new Error('INTERNAL_API_KEY must be set in environment variables');
  }
  const turnstileSecret =
    options.turnstileSecret !== undefined
      ? options.turnstileSecret
      : process.env.NODE_ENV === 'test'
        ? ''
        : process.env.TURNSTILE_SECRET_KEY || '';
  const turnstileRequired =
    options.turnstileRequired !== undefined
      ? options.turnstileRequired
      : process.env.NODE_ENV === 'production';
  const inspectorHub = getInspectorHub();

  // Instantiate Repositories
  const userRepo = new UserRepository(dbClient);
  const personaRepo = new PersonaRepository(dbClient);
  const entitlementRepo = new EntitlementRepository(dbClient);
  const serverRepo = new GameServerRepository(dbClient);
  const statsRepo = new StatsRepository(dbClient);
  const serverHistoryRepo = new ServerHistoryRepository(dbClient);

  // Decorate server instance
  server.decorate('db', dbClient);
  server.decorate('userRepo', userRepo);
  server.decorate('personaRepo', personaRepo);
  server.decorate('entitlementRepo', entitlementRepo);
  server.decorate('serverRepo', serverRepo);
  server.decorate('statsRepo', statsRepo);
  server.decorate('serverHistoryRepo', serverHistoryRepo);
  server.decorate('inspectorHub', inspectorHub);
  server.decorate('turnstileSecret', turnstileSecret);
  server.decorate('turnstileRequired', turnstileRequired);

  // Register Core Plugins
  await server.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  });

  await server.register(jwt, {
    secret: jwtSecret
  });

  await server.register(rateLimit, {
    max: 1000,
    timeWindow: '1 minute'
  });

  await server.register(websocket);

  // Authentication Decorators
  server.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch (err: any) {
      return reply.code(401).send({ error: 'Unauthorized: Invalid or missing token' });
    }
  });

  server.decorate('authenticateAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const user = request.user as any;
      if (!user || !user.isAdmin) {
        return reply.code(403).send({ error: 'Forbidden: Admin privileges required' });
      }
    } catch (err: any) {
      return reply.code(401).send({ error: 'Unauthorized: Invalid or missing token' });
    }
  });

  server.decorate('authenticateInternal', async (request: FastifyRequest, reply: FastifyReply) => {
    const key = (request.headers['x-internal-key'] || request.headers['x-internal-api-key']) as string;
    if (!key || key !== internalApiKey) {
      return reply.code(403).send({ error: 'Forbidden: Invalid internal API key' });
    }
  });

  // Health and System Check
  server.get('/health', async () => {
    return {
      status: 'OK',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      dbConnected: true
    };
  });

  server.get('/', async () => {
    return {
      name: 'mohPA API Service',
      version: '1.0.0',
      docs: '/api/v1',
      endpoints: {
        auth: '/api/v1/auth',
        personas: '/api/v1/personas',
        entitlements: '/api/v1/entitlements',
        servers: '/api/v1/servers',
        stats: '/api/v1/stats',
        admin: '/api/v1/admin',
        inspectorWs: '/ws/inspector'
      }
    };
  });

  // Register REST Routes
  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  await server.register(personaRoutes, { prefix: '/api/v1/personas' });
  await server.register(entitlementRoutes, { prefix: '/api/v1/entitlements' });
  await server.register(serverRoutes, { prefix: '/api/v1/servers' });
  await server.register(statsRoutes, { prefix: '/api/v1/stats' });
  await server.register(adminRoutes, { prefix: '/api/v1/admin' });
  await server.register(internalRoutes, { prefix: '/internal' });
  await server.register(newsRoutes);

  // Register WebSocket Inspector Route
  server.get('/ws/inspector', { websocket: true }, (socket, req) => {
    inspectorHub.handleConnection(socket);
  });

  return server;
}
