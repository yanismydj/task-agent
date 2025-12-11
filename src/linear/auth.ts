import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'linear-auth' });

const LINEAR_AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';
const LINEAR_REVOKE_URL = 'https://api.linear.app/oauth/revoke';

const CALLBACK_PORT = 3456;
const CALLBACK_PATH = '/oauth/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

// Scopes needed for TaskAgent
// See: https://linear.app/developers/oauth-actor-authorization
const SCOPES = [
  'read',
  'write',
  'issues:create',
  'comments:create',
  'app:assignable',   // Agent can be assigned issues
  'app:mentionable',  // Agent can be @mentioned
];

interface TokenData {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
  expires_at: string; // ISO date string
}

interface LinearAuthConfig {
  clientId: string;
  clientSecret: string;
  tokenStorePath?: string;
}

export class LinearAuth {
  private clientId: string;
  private clientSecret: string;
  private tokenStorePath: string;
  private tokenData: TokenData | null = null;

  constructor(config: LinearAuthConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.tokenStorePath = config.tokenStorePath || path.join(process.cwd(), '.task-agent-token.json');
    this.loadToken();
  }

  private loadToken(): void {
    try {
      if (fs.existsSync(this.tokenStorePath)) {
        const data = fs.readFileSync(this.tokenStorePath, 'utf-8');
        this.tokenData = JSON.parse(data) as TokenData;
        logger.debug('Loaded stored OAuth token');
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to load stored token');
      this.tokenData = null;
    }
  }

  private saveToken(): void {
    try {
      fs.writeFileSync(this.tokenStorePath, JSON.stringify(this.tokenData, null, 2));
      logger.debug('Saved OAuth token to storage');
    } catch (error) {
      logger.error({ error }, 'Failed to save token');
    }
  }

  private isTokenValid(): boolean {
    if (!this.tokenData) return false;

    const expiresAt = new Date(this.tokenData.expires_at);
    const bufferMs = 5 * 60 * 1000; // 5 minutes buffer
    return new Date().getTime() < expiresAt.getTime() - bufferMs;
  }

  async getAccessToken(): Promise<string> {
    // Return cached token if still valid
    if (this.tokenData && this.isTokenValid()) {
      return this.tokenData.access_token;
    }

    // Try to refresh if we have a refresh token
    if (this.tokenData?.refresh_token) {
      try {
        await this.refreshToken();
        return this.tokenData!.access_token;
      } catch (error) {
        logger.warn({ error }, 'Token refresh failed, need re-authorization');
      }
    }

    // No valid token - need to run OAuth flow
    throw new Error(
      'No valid Linear OAuth token. Run `npm run auth` to authorize TaskAgent with Linear.'
    );
  }

  async authorize(): Promise<void> {
    logger.info('Starting Linear OAuth authorization flow');

    const state = this.generateState();
    const authUrl = this.buildAuthUrl(state);

    console.log('\n🔐 Linear OAuth Authorization Required\n');
    console.log('Opening browser for authorization...');
    console.log(`If browser doesn't open, visit: ${authUrl}\n`);

    // Open browser
    const { exec } = await import('node:child_process');
    const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${openCmd} "${authUrl}"`);

    // Start callback server and wait for code
    const code = await this.waitForCallback(state);

    // Exchange code for token
    await this.exchangeCodeForToken(code);

    console.log('✅ Authorization successful! Token saved.\n');
  }

  private generateState(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  private buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPES.join(','),
      state,
      actor: 'app', // Create dedicated bot user
    });
    return `${LINEAR_AUTHORIZE_URL}?${params.toString()}`;
  }

  private waitForCallback(expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url || '', `http://localhost:${CALLBACK_PORT}`);

        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400);
          res.end(`Authorization failed: ${error}`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (state !== expectedState) {
          res.writeHead(400);
          res.end('Invalid state parameter');
          server.close();
          reject(new Error('OAuth state mismatch'));
          return;
        }

        if (!code) {
          res.writeHead(400);
          res.end('Missing authorization code');
          server.close();
          reject(new Error('No authorization code received'));
          return;
        }

        // Success!
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>TaskAgent Authorization</title></head>
            <body style="font-family: system-ui; padding: 40px; text-align: center;">
              <h1>✅ Authorization Successful!</h1>
              <p>You can close this window and return to the terminal.</p>
            </body>
          </html>
        `);

        server.close();
        resolve(code);
      });

      server.listen(CALLBACK_PORT, () => {
        logger.info({ port: CALLBACK_PORT }, 'OAuth callback server started');
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('OAuth authorization timed out'));
      }, 5 * 60 * 1000);
    });
  }

  private async exchangeCodeForToken(code: string): Promise<void> {
    logger.info('Exchanging authorization code for token');

    const response = await fetch(LINEAR_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: REDIRECT_URI,
        code,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Failed to exchange code for token: ${response.status} ${errorBody}`);
    }

    const data = (await response.json()) as Omit<TokenData, 'expires_at'>;

    this.tokenData = {
      ...data,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    };

    this.saveToken();
    logger.info({ expiresAt: this.tokenData.expires_at }, 'OAuth token obtained');
  }

  private async refreshToken(): Promise<void> {
    if (!this.tokenData?.refresh_token) {
      throw new Error('No refresh token available');
    }

    logger.info('Refreshing OAuth token');

    const response = await fetch(LINEAR_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.tokenData.refresh_token,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Failed to refresh token: ${response.status} ${errorBody}`);
    }

    const data = (await response.json()) as Omit<TokenData, 'expires_at'>;

    this.tokenData = {
      ...data,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    };

    this.saveToken();
    logger.info({ expiresAt: this.tokenData.expires_at }, 'OAuth token refreshed');
  }

  async revoke(): Promise<void> {
    if (!this.tokenData) {
      logger.warn('No token to revoke');
      return;
    }

    try {
      await fetch(LINEAR_REVOKE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${this.tokenData.access_token}`,
        },
      });
      logger.info('OAuth token revoked');
    } catch (error) {
      logger.warn({ error }, 'Failed to revoke token');
    }

    this.tokenData = null;
    try {
      fs.unlinkSync(this.tokenStorePath);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  invalidateToken(): void {
    logger.info('Invalidating cached OAuth token');
    this.tokenData = null;
    try {
      fs.unlinkSync(this.tokenStorePath);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  hasValidToken(): boolean {
    return this.isTokenValid();
  }
}

// Singleton instance - will be initialized lazily
let authInstance: LinearAuth | null = null;

export function initializeAuth(config: LinearAuthConfig): LinearAuth {
  authInstance = new LinearAuth(config);
  return authInstance;
}

export function getAuth(): LinearAuth {
  if (!authInstance) {
    throw new Error('LinearAuth not initialized. Call initializeAuth first.');
  }
  return authInstance;
}
