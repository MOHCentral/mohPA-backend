import dotenv from 'dotenv';

dotenv.config();

export interface FeslEngineConfig {
  host: string;
  publicIp: string;
  feslClientPort: number;
  feslServerPort: number;
  theaterClientPort: number;
  theaterServerPort: number;
  gpcmPort: number;
  gpspPort: number;
  availablePort: number;
  gstatsPort: number;
  masterPort: number;
  masterAltPort: number;
  sbPort: number;
  peerchatPort: number;
  peerchatAltPort: number;
  inspectorPort: number;
  theaterHost: string;
  messengerHost: string;
  messengerPort: number;
  activityTimeoutSecs: number;
  sessionTtlSecs: number;
  defaultDomainPartition: string;
  redisUrl?: string;
  apiServiceUrl: string;
  internalApiKey: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

export const config: FeslEngineConfig = {
  host: process.env.HOST || '0.0.0.0',
  publicIp: process.env.PUBLIC_IP || '127.0.0.1',
  feslClientPort: parseInt(process.env.FESL_CLIENT_PORT || '18020', 10),
  feslServerPort: parseInt(process.env.FESL_SERVER_PORT || '18051', 10),
  theaterClientPort: parseInt(process.env.THEATER_CLIENT_PORT || '18275', 10),
  theaterServerPort: parseInt(process.env.THEATER_SERVER_PORT || '18056', 10),
  gpcmPort: parseInt(process.env.GPCM_PORT || '29900', 10),
  gpspPort: parseInt(process.env.GPSP_PORT || '29901', 10),
  availablePort: parseInt(process.env.GS_AVAILABLE_PORT || '27900', 10),
  gstatsPort: parseInt(process.env.GSTATS_PORT || '29920', 10),
  masterPort: parseInt(process.env.GS_MASTER_PORT || '28900', 10),
  masterAltPort: parseInt(process.env.GS_MASTER_ALT_PORT || '27900', 10),
  sbPort: parseInt(process.env.GS_SB_PORT || '28910', 10),
  peerchatPort: parseInt(process.env.PEERCHAT_PORT || '18667', 10),
  peerchatAltPort: parseInt(process.env.PEERCHAT_ALT_PORT || '6667', 10),
  inspectorPort: parseInt(process.env.INSPECTOR_PORT || '9999', 10),
  theaterHost: process.env.THEATER_HOST || process.env.PUBLIC_IP || '127.0.0.1',
  messengerHost: process.env.MESSENGER_HOST || process.env.PUBLIC_IP || '127.0.0.1',
  messengerPort: parseInt(process.env.MESSENGER_PORT || '18020', 10),
  activityTimeoutSecs: parseInt(process.env.ACTIVITY_TIMEOUT_SECS || '120', 10),
  sessionTtlSecs: parseInt(process.env.SESSION_TTL_SECS || '86400', 10), // 24 hours
  defaultDomainPartition: process.env.DEFAULT_DOMAIN_PARTITION || 'mohpa',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  apiServiceUrl: process.env.API_SERVICE_URL || 'http://127.0.0.1:3000',
  internalApiKey: process.env.INTERNAL_API_KEY || (process.env.NODE_ENV === 'test' ? 'test-internal-api-key' : (() => { throw new Error('INTERNAL_API_KEY must be set in environment variables'); })()),
  tlsCertPath: process.env.TLS_CERT_PATH,
  tlsKeyPath: process.env.TLS_KEY_PATH,
};
