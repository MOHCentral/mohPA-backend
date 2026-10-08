/**
 * mohPA Game Server UDP Query Client
 * Supports GameSpy 1 and Quake 3 / id Tech 3 query protocols for dedicated game servers.
 */

import * as dgram from 'node:dgram';

export interface ScoreboardPlayer {
  name: string;
  score: number;
  kills?: number;
  deaths?: number;
  ping: number;
  team?: number;
  [key: string]: any;
}

export interface GameQueryOptions {
  host: string;
  port: number;
  queryPort?: number;
  gameSlug?: string;
  timeoutMs?: number;
}

export interface ServerQueryResult {
  online: boolean;
  name?: string;
  gameSlug?: string;
  mapName?: string;
  gameMode?: string;
  currentPlayers: number;
  maxPlayers: number;
  ping: number;
  protocol: 'gamespy1' | 'quake3' | 'unknown';
  queryPort: number;
  players: ScoreboardPlayer[];
  rules: Record<string, any>;
  raw?: Record<string, any>;
  error?: string;
}

/**
 * Parses GameSpy 1 key-value string and extracts server info, players, and rules.
 */
export function parseGameSpy1Response(dataStr: string): Omit<ServerQueryResult, 'online' | 'ping' | 'queryPort'> {
  // GS1 responses are structured as: \key\val\key\val...
  const parts = dataStr.split('\\');
  // First element might be empty if string starts with \
  if (parts.length > 0 && parts[0] === '') {
    parts.shift();
  }

  const raw: Record<string, string> = {};
  for (let i = 0; i < parts.length - 1; i += 2) {
    const k = parts[i].trim();
    const v = parts[i + 1].trim();
    if (k) {
      raw[k] = v;
    }
  }

  const lowerMap = new Map<string, string>();
  for (const [k, v] of Object.entries(raw)) {
    lowerMap.set(k.toLowerCase(), v);
  }

  const name = lowerMap.get('hostname') || lowerMap.get('sv_hostname') || lowerMap.get('servername') || undefined;
  const mapName = lowerMap.get('mapname') || lowerMap.get('map') || undefined;
  const gameMode = lowerMap.get('gametype') || lowerMap.get('game_mode') || lowerMap.get('gamemode') || undefined;
  const numPlayersVal = lowerMap.get('numplayers') || lowerMap.get('clients');
  const maxPlayersVal = lowerMap.get('maxplayers') || lowerMap.get('sv_maxclients');

  // Extract players (player_0, score_0, ping_0, etc.)
  const playerIndices = new Set<number>();
  const playerRegex = /^player_?(\d+)$/i;

  for (const key of Object.keys(raw)) {
    const match = key.match(playerRegex);
    if (match) {
      playerIndices.add(parseInt(match[1], 10));
    }
  }

  const players: ScoreboardPlayer[] = [];
  for (const idx of Array.from(playerIndices).sort((a, b) => a - b)) {
    const pName = raw[`player_${idx}`] || raw[`player${idx}`] || `Player_${idx}`;
    const pScore = parseInt(raw[`score_${idx}`] || raw[`score${idx}`] || raw[`frags_${idx}`] || '0', 10);
    const pPing = parseInt(raw[`ping_${idx}`] || raw[`ping${idx}`] || '0', 10);
    const rawKills = raw[`kills_${idx}`] ?? raw[`kills${idx}`] ?? raw[`frags_${idx}`] ?? raw[`frags${idx}`] ?? raw[`kill_${idx}`];
    const rawDeaths = raw[`deaths_${idx}`] ?? raw[`deaths${idx}`] ?? raw[`death_${idx}`];
    const pDeaths = rawDeaths !== undefined ? parseInt(rawDeaths, 10) : 0;
    const pKills = rawKills !== undefined ? parseInt(rawKills, 10) : (!isNaN(pScore) ? pScore : 0);
    const pTeam = raw[`team_${idx}`] !== undefined ? parseInt(raw[`team_${idx}`], 10) : undefined;

    players.push({
      name: pName,
      score: isNaN(pScore) ? 0 : pScore,
      kills: isNaN(pKills) ? 0 : pKills,
      deaths: isNaN(pDeaths) ? 0 : pDeaths,
      ping: isNaN(pPing) ? 0 : pPing,
      team: pTeam !== undefined && !isNaN(pTeam) ? pTeam : undefined,
    });
  }

  const currentPlayers = numPlayersVal ? parseInt(numPlayersVal, 10) : players.length;
  const maxPlayers = maxPlayersVal ? parseInt(maxPlayersVal, 10) : 64;

  // Extract rules (all non-standard keys)
  const standardKeys = new Set([
    'hostname', 'sv_hostname', 'servername',
    'mapname', 'map',
    'gametype', 'game_mode', 'gamemode',
    'numplayers', 'clients',
    'maxplayers', 'sv_maxclients',
    'final', 'queryid'
  ]);

  const rules: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) {
    const lowerKey = k.toLowerCase();
    if (!standardKeys.has(lowerKey) && !lowerKey.startsWith('player') && !lowerKey.startsWith('score') && !lowerKey.startsWith('ping') && !lowerKey.startsWith('deaths') && !lowerKey.startsWith('team')) {
      rules[k] = v;
    }
  }

  return {
    name,
    mapName,
    gameMode,
    currentPlayers: isNaN(currentPlayers) ? players.length : currentPlayers,
    maxPlayers: isNaN(maxPlayers) ? 64 : maxPlayers,
    protocol: 'gamespy1',
    players,
    rules,
    raw,
  };
}

/**
 * Parses Quake 3 / id Tech 3 statusResponse packet.
 */
export function parseQuake3Response(dataStr: string): Omit<ServerQueryResult, 'online' | 'ping' | 'queryPort'> {
  // Expected prefix: \xFF\xFF\xFF\xFFstatusResponse\n\cvar\val\cvar\val...\n<score> <ping> "<name>"\n...
  const cleanStr = dataStr.replace(/^\xFF\xFF\xFF\xFFstatusResponse\n?/i, '').replace(/^\xFF\xFF\xFF\xFFinfoResponse\n?/i, '');
  const lines = cleanStr.split('\n');

  const cvarLine = lines[0] || '';
  const cvarParts = cvarLine.split('\\');
  if (cvarParts.length > 0 && cvarParts[0] === '') {
    cvarParts.shift();
  }

  const raw: Record<string, string> = {};
  for (let i = 0; i < cvarParts.length - 1; i += 2) {
    const k = cvarParts[i].trim();
    const v = cvarParts[i + 1].trim();
    if (k) {
      raw[k] = v;
    }
  }

  const lowerMap = new Map<string, string>();
  for (const [k, v] of Object.entries(raw)) {
    lowerMap.set(k.toLowerCase(), v);
  }

  const name = lowerMap.get('sv_hostname') || lowerMap.get('hostname') || undefined;
  const mapName = lowerMap.get('mapname') || undefined;
  const gameMode = lowerMap.get('gametype') || lowerMap.get('g_gametype') || undefined;
  const maxPlayersVal = lowerMap.get('sv_maxclients') || lowerMap.get('maxclients');

  // Player lines format: <score> <ping> "<name>"
  const players: ScoreboardPlayer[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const match = line.match(/^([-\d]+)\s+(\d+)\s+"(.*)"$/);
    if (match) {
      const pScore = parseInt(match[1], 10) || 0;
      players.push({
        score: pScore,
        kills: pScore,
        deaths: 0,
        ping: parseInt(match[2], 10) || 0,
        name: match[3] || `Player_${i}`,
      });
    }
  }

  const currentPlayers = players.length;
  const maxPlayers = maxPlayersVal ? parseInt(maxPlayersVal, 10) : 64;

  return {
    name,
    mapName,
    gameMode,
    currentPlayers,
    maxPlayers: isNaN(maxPlayers) ? 64 : maxPlayers,
    protocol: 'quake3',
    players,
    rules: raw,
    raw,
  };
}

/**
 * Queries a single UDP port for game server status.
 */
function probePort(
  host: string,
  port: number,
  timeoutMs: number
): Promise<{ result: Omit<ServerQueryResult, 'online' | 'ping' | 'queryPort'>; ping: number; port: number } | null> {
  return new Promise((resolve) => {
    let socket: dgram.Socket | null = null;
    let timer: NodeJS.Timeout | null = null;
    let resolved = false;
    const startTime = Date.now();

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (socket) {
        try {
          socket.close();
        } catch {}
        socket = null;
      }
    };

    const done = (val: { result: Omit<ServerQueryResult, 'online' | 'ping' | 'queryPort'>; ping: number; port: number } | null) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(val);
      }
    };

    timer = setTimeout(() => {
      done(null);
    }, timeoutMs);

    try {
      socket = dgram.createSocket('udp4');

      socket.on('error', () => {
        done(null);
      });

      socket.on('message', (msg: Buffer) => {
        const ping = Date.now() - startTime;
        const str = msg.toString('binary');

        // Check Quake 3 response
        if (str.startsWith('\xFF\xFF\xFF\xFFstatusResponse') || str.startsWith('\xFF\xFF\xFF\xFFinfoResponse')) {
          try {
            const parsed = parseQuake3Response(str);
            return done({ result: parsed, ping, port });
          } catch {}
        }

        // Check GameSpy 1 response
        const asciiStr = msg.toString('utf-8');
        if (asciiStr.includes('\\hostname\\') || asciiStr.includes('\\mapname\\') || asciiStr.includes('\\gamename\\') || asciiStr.includes('\\numplayers\\') || asciiStr.startsWith('\\')) {
          try {
            const parsed = parseGameSpy1Response(asciiStr);
            return done({ result: parsed, ping, port });
          } catch {}
        }
      });

      // Send GameSpy 1 probe
      const gs1Packet = Buffer.from('\\status\\', 'ascii');
      socket.send(gs1Packet, 0, gs1Packet.length, port, host, () => {});

      // Send Quake 3 probe
      const q3Packet = Buffer.from('\xFF\xFF\xFF\xFFgetstatus\x00', 'binary');
      socket.send(q3Packet, 0, q3Packet.length, port, host, () => {});
    } catch {
      done(null);
    }
  });
}

/**
 * Queries a dedicated game server via UDP.
 * Probes the provided queryPort (or standard candidate ports) using GameSpy 1 and Quake 3 in parallel.
 */
export async function queryGameServer(options: GameQueryOptions): Promise<ServerQueryResult> {
  const host = options.host.trim();
  const gamePort = options.port;
  const timeoutMs = options.timeoutMs ?? 1500;

  // Determine candidate ports to probe
  const candidatePorts: number[] = [];
  if (options.queryPort && options.queryPort > 0) {
    candidatePorts.push(options.queryPort);
    if (gamePort && gamePort !== options.queryPort) {
      candidatePorts.push(gamePort);
    }
  } else {
    candidatePorts.push(gamePort);
    candidatePorts.push(gamePort + 97);
    if (!candidatePorts.includes(29900)) {
      candidatePorts.push(29900);
    }
  }

  // Probe all candidate ports concurrently
  try {
    // Wrap probePort to reject on null so Promise.any can short-circuit on the first success
    const probePromises = candidatePorts.map((port) =>
      probePort(host, port, timeoutMs).then((res) => {
        if (res === null) throw new Error(`Port ${port} failed or timed out`);
        return res;
      })
    );
    // Catch AggregateError when all ports fail and return undefined to match original logic
    const successful = await Promise.any(probePromises).catch(() => undefined);

    if (successful) {
      return {
        online: true,
        queryPort: successful.port,
        ping: successful.ping,
        gameSlug: options.gameSlug,
        ...successful.result,
      };
    }
  } catch {}

  // Failed / offline
  return {
    online: false,
    queryPort: options.queryPort || gamePort,
    ping: 0,
    currentPlayers: 0,
    maxPlayers: 64,
    protocol: 'unknown',
    players: [],
    rules: {},
    error: `No response from game server at ${host} on candidate ports [${candidatePorts.join(', ')}]`,
  };
}
