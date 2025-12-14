import { spawn, type ChildProcess } from 'node:child_process';
import { createChildLogger } from './logger.js';

const logger = createChildLogger({ module: 'ngrok' });

interface NgrokInfo {
  url: string | null;
  process: ChildProcess | null;
}

let ngrokInstance: NgrokInfo = {
  url: null,
  process: null,
};

/**
 * Start ngrok tunnel for webhook server
 * Returns a promise that resolves when ngrok URL is captured
 */
export async function startNgrok(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    // Don't log during startup - let the caller handle status updates
    // This prevents console output before the splash screen is ready

    const proc = spawn('ngrok', ['http', String(port), '--log=stdout'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        // Only log warning after startup is complete
        setTimeout(() => {
          logger.warn('Ngrok URL not found within timeout, continuing without URL');
        }, 100);
        resolved = true;
        resolve(null);
      }
    }, 5000); // 5 second timeout

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();

      // Look for the public URL in ngrok output
      const urlMatch = text.match(/url=(https:\/\/[^\s]+\.ngrok[^\s]*)/);
      if (urlMatch && urlMatch[1] && !resolved) {
        const url = urlMatch[1];
        ngrokInstance.url = url;
        // Defer logging until after splash screen
        setTimeout(() => {
          logger.info({ url }, 'Ngrok tunnel established');
          logger.info({ endpoint: `${url}/webhook` }, 'Webhook endpoint ready');
        }, 100);
        clearTimeout(timeout);
        resolved = true;
        resolve(url);
        return;
      }

      // Also check for JSON format
      const jsonUrlMatch = text.match(/"URL":"(https:\/\/[^"]+)"/);
      if (jsonUrlMatch && jsonUrlMatch[1] && !resolved) {
        const url = jsonUrlMatch[1];
        ngrokInstance.url = url;
        // Defer logging until after splash screen
        setTimeout(() => {
          logger.info({ url }, 'Ngrok tunnel established');
          logger.info({ endpoint: `${url}/webhook` }, 'Webhook endpoint ready');
        }, 100);
        clearTimeout(timeout);
        resolved = true;
        resolve(url);
        return;
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        // Defer debug logs
        setTimeout(() => {
          logger.debug({ message: text }, 'Ngrok stderr');
        }, 100);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Defer error logs
        setTimeout(() => {
          logger.error('ngrok not found. Install with: brew install ngrok');
          logger.error('Then authenticate with: ngrok authtoken <your-token>');
        }, 100);
      } else {
        setTimeout(() => {
          logger.error({ error: err.message }, 'Ngrok error');
        }, 100);
      }
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });

    proc.on('exit', (code) => {
      if (code !== null && code !== 0) {
        logger.warn({ code }, 'Ngrok exited');
      }
      ngrokInstance.process = null;
      ngrokInstance.url = null;
    });

    ngrokInstance.process = proc;
  });
}

/**
 * Stop ngrok tunnel
 */
export function stopNgrok(): void {
  if (ngrokInstance.process && !ngrokInstance.process.killed) {
    logger.info('Stopping ngrok tunnel');
    ngrokInstance.process.kill('SIGTERM');
    ngrokInstance.process = null;
  }
  ngrokInstance.url = null;
}

/**
 * Get current ngrok URL
 */
export function getNgrokUrl(): string | null {
  return ngrokInstance.url;
}
