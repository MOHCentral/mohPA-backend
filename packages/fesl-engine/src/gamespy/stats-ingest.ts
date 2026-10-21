/** Turn one final gstats snapshot into the body for POST /internal/stats/report. */

export interface SnapshotPlayer {
  index: number;
  name: string;
  kills: number;
  deaths: number;
  score: number;
  timePlayedSeconds: number;
  customStats: Record<string, number>;
  personaId?: string;
}

export interface StatsReportBody {
  statsMatchKey: string;
  match: {
    gameSlug: string;
    mapName: string;
    gameMode: string;
    durationSeconds: number;
    details: {
      gamedata: Record<string, string>;
      players: SnapshotPlayer[];
    };
  };
  players: Array<{
    personaId: string;
    kills: number;
    deaths: number;
    score: number;
    timePlayedSeconds: number;
    customStats: Record<string, number>;
  }>;
}

const RESERVED = new Set([
  'numKills',
  'kills',
  'deaths',
  'numDeaths',
  'playTime',
  'teamBonus',
  'score',
  'player',
  'name',
]);

export function parseGamedataPairs(gamedata: string): Record<string, string> {
  const parts = gamedata.split('\\');
  let i = parts[0] === '' ? 1 : 0;
  const out: Record<string, string> = {};
  for (; i + 1 < parts.length; i += 2) {
    if (!parts[i]) continue;
    out[parts[i]] = parts[i + 1];
  }
  return out;
}

function intValue(value: string | undefined): number | null {
  if (value == null || !/^-?\d+$/.test(value)) return null;
  return Number(value);
}

function firstInt(buckets: Record<string, string>, keys: string[]): { present: boolean; value: number } {
  for (const key of keys) {
    if (!(key in buckets)) continue;
    const n = intValue(buckets[key]);
    if (n == null) continue;
    return { present: true, value: n };
  }
  return { present: false, value: 0 };
}

function playTimeKey(gametype: string): string {
  const mode = gametype.toLowerCase();
  if (mode.includes('invader')) return 'totalPlayTime_Invader';
  if (mode.includes('team')) return 'totalPlayTime_TeamMatch';
  if (mode.includes('ffa')) return 'totalPlayTime_FFA';
  return 'totalPlayTime_Ranked';
}

function playerFromBuckets(buckets: Record<string, string>, gametype: string): Omit<SnapshotPlayer, 'index' | 'name'> {
  const kills = firstInt(buckets, ['numKills', 'kills']);
  const deaths = firstInt(buckets, ['deaths', 'numDeaths']);
  const score = firstInt(buckets, ['teamBonus', 'score']);
  const playTime = firstInt(buckets, ['playTime']);
  const customStats: Record<string, number> = {};
  if (kills.present) customStats.totalNumKills = kills.value;
  if (deaths.present) customStats.totalNumDeaths = deaths.value;
  if (score.present) customStats.totalTeamBonusPoints = score.value;
  if (playTime.present) customStats[playTimeKey(gametype)] = playTime.value;

  for (const [key, value] of Object.entries(buckets)) {
    if (key.startsWith('total') || RESERVED.has(key)) continue;
    const n = intValue(value);
    if (n == null) continue;
    customStats[key] = n;
  }

  return {
    kills: kills.value,
    deaths: deaths.value,
    score: score.value,
    timePlayedSeconds: playTime.value,
    customStats,
  };
}

export function parseSnapshot(gamedata: string): {
  flat: Record<string, string>;
  players: SnapshotPlayer[];
  mapName: string;
  gameMode: string;
  durationSeconds: number;
} {
  const flat = parseGamedataPairs(gamedata);
  const gametype = flat.gametype || '';
  const byIndex = new Map<number, Record<string, string>>();

  for (const [key, value] of Object.entries(flat)) {
    if (/_t\d+$/.test(key)) continue;
    const player = key.match(/^(.*)_(\d+)$/);
    if (!player || !player[1]) continue;
    const index = Number(player[2]);
    const row = byIndex.get(index) || {};
    row[player[1]] = value;
    byIndex.set(index, row);
  }

  const players: SnapshotPlayer[] = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, buckets]) => ({
      index,
      name: buckets.player || buckets.name || '',
      ...playerFromBuckets(buckets, gametype),
    }));

  const mapName = flat.map || flat.mapname || flat.hostname || 'unknown';
  const durationSeconds = players.reduce((max, player) => Math.max(max, player.timePlayedSeconds), 0);

  return {
    flat,
    players,
    mapName: mapName || 'unknown',
    gameMode: gametype || 'unknown',
    durationSeconds,
  };
}

export async function buildStatsReport(
  connid: string,
  sesskey: string,
  gamedata: string,
  lookup: (name: string) => Promise<string | null>
): Promise<StatsReportBody> {
  const snapshot = parseSnapshot(gamedata);
  const players: SnapshotPlayer[] = await Promise.all(
    snapshot.players.map(async (player) => {
      const personaId = player.name ? await lookup(player.name) : null;
      return { ...player, personaId: personaId || undefined };
    })
  );

  return {
    statsMatchKey: `mohpa:${connid}:${sesskey}`,
    match: {
      gameSlug: 'mohpa',
      mapName: snapshot.mapName,
      gameMode: snapshot.gameMode,
      durationSeconds: snapshot.durationSeconds,
      details: { gamedata: snapshot.flat, players },
    },
    players: players
      .filter((player) => player.personaId)
      .map((player) => ({
        personaId: player.personaId as string,
        kills: player.kills,
        deaths: player.deaths,
        score: player.score,
        timePlayedSeconds: player.timePlayedSeconds,
        customStats: player.customStats,
      })),
  };
}

export class GstatsMatchBuffer {
  private last = new Map<string, string>();

  takeFinal(cmd: { connid?: string; sesskey?: string; done: string; gamedata: string }): {
    connid: string;
    sesskey: string;
    gamedata: string;
  } | null {
    const connid = cmd.connid || '';
    const sesskey = cmd.sesskey || '';
    const key = `${connid}:${sesskey}`;
    if (cmd.done !== '1') {
      this.last.set(key, cmd.gamedata);
      return null;
    }
    const gamedata = cmd.gamedata || this.last.get(key) || '';
    this.last.delete(key);
    return { connid, sesskey, gamedata };
  }
}
