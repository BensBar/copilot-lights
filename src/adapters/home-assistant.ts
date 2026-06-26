import { request } from 'undici';
import type { Dispatcher } from 'undici';
import { z } from 'zod';
import type { LightAdapter, LightFrame, LightSnapshot } from './adapter.js';
import type { HomeAssistantConfigSchema } from '../config/schema.js';

export interface HomeAssistantSnapshot extends LightSnapshot {
  _kind: 'home-assistant';
  capturedAt: number;
  /** Per-entity state captured from /api/states/<entity>. */
  entities: Array<{
    entityId: string;
    state: 'on' | 'off';
    rgb?: [number, number, number];
    brightness?: number; // HA brightness is 0..255
  }>;
}

interface HomeAssistantEntityState {
  entity_id: string;
  state: string;
  attributes: {
    rgb_color?: [number, number, number];
    brightness?: number;
    [key: string]: unknown;
  };
}

export class HomeAssistantAdapter implements LightAdapter {
  readonly kind = 'home-assistant';
  private cfg: z.infer<typeof HomeAssistantConfigSchema>;
  private dispatcher: Dispatcher | undefined;
  private _closed = false;
  private inFlight: Promise<void> | null = null;
  private pendingFrame: LightFrame | null = null;
  private baseUrl: string;

  constructor(cfg: z.infer<typeof HomeAssistantConfigSchema>, opts?: { dispatcher?: unknown }) {
    this.cfg = cfg;
    this.dispatcher = opts?.dispatcher as Dispatcher | undefined;
    // Normalize baseUrl: remove trailing slash for consistency
    this.baseUrl = this.cfg.baseUrl.replace(/\/$/, '');
  }

  async connect(): Promise<void> {
    if (this._closed) {
      throw new Error('HomeAssistantAdapter is closed');
    }

    const url = `${this.baseUrl}/api/`;
    try {
      const { statusCode, body } = await request(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
        },
        dispatcher: this.dispatcher,
        headersTimeout: 5000,
        bodyTimeout: 5000,
      });

      if (statusCode === 401) {
        throw new Error(`HomeAssistant API (${url}): Unauthorized (401) — check token`);
      }

      if (statusCode !== 200) {
        const text = await body.text();
        throw new Error(
          `HomeAssistant API (${url}): HTTP ${statusCode} — ${text || 'no response body'}`
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.includes('connect ECONNREFUSED')) {
        throw new Error(`HomeAssistant API (${url}): Connection refused — is the server running?`);
      }
      throw err;
    }
  }

  async applyFrame(frame: LightFrame): Promise<void> {
    if (this._closed) {
      throw new Error('HomeAssistantAdapter is closed');
    }

    this.pendingFrame = frame;

    // If a request is in flight, just update pendingFrame and return
    if (this.inFlight) {
      return;
    }

    // Start the in-flight request
    this.inFlight = this._sendFrame(frame).finally(() => {
      this.inFlight = null;

      // If a new frame was pending, send it now
      if (this.pendingFrame !== frame && this.pendingFrame !== null) {
        const nextFrame = this.pendingFrame;
        this.pendingFrame = null;
        // Recursively call applyFrame to handle the next frame
        // This will queue it properly with coalescing
        void this.applyFrame(nextFrame);
      }
    });

    return this.inFlight;
  }

  private async _sendFrame(frame: LightFrame): Promise<void> {
    const results = await Promise.allSettled(
      this.cfg.entities.map((entityId) => this._applyToEntity(entityId, frame))
    );

    const failures: Array<{ entityId: string; reason: unknown }> = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result && result.status === 'rejected') {
        failures.push({
          entityId: this.cfg.entities[i]!,
          reason: (result as PromiseRejectedResult).reason,
        });
      }
    }

    if (failures.length > 0) {
      const failureMessage = failures
        .map((f) => {
          const reason = f.reason instanceof Error ? f.reason.message : String(f.reason);
          return `${f.entityId}: ${reason}`;
        })
        .join('; ');

      const error = new Error(`HomeAssistant applyFrame failed for entities: ${failureMessage}`);
      (error as any).failures = failures;
      throw error;
    }
  }

  private async _applyToEntity(entityId: string, frame: LightFrame): Promise<void> {
    const url = `${this.baseUrl}/api/services/light/turn_on`;
    const haBrightness = Math.round((frame.brightness * 255) / 100);
    const transitionSeconds = (frame.transitionMs ?? 0) / 1000;

    const body = {
      entity_id: entityId,
      rgb_color: [frame.rgb.r, frame.rgb.g, frame.rgb.b],
      brightness: haBrightness,
      transition: transitionSeconds,
    };

    try {
      const { statusCode, body: responseBody } = await request(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        dispatcher: this.dispatcher,
        headersTimeout: 5000,
        bodyTimeout: 5000,
      });

      if (statusCode >= 400) {
        const text = await responseBody.text();
        throw new Error(
          `${entityId}: HTTP ${statusCode} — ${text || 'no response body'}`
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (
        errorMessage.includes('connect ECONNREFUSED') ||
        errorMessage.includes('ECONNREFUSED')
      ) {
        throw new Error(`${entityId}: Connection refused`);
      }
      throw err;
    }
  }

  async getSnapshot(): Promise<HomeAssistantSnapshot> {
    if (this._closed) {
      throw new Error('HomeAssistantAdapter is closed');
    }

    const entities = await Promise.all(
      this.cfg.entities.map((entityId) => this._getEntityState(entityId))
    );

    const snapshot: HomeAssistantSnapshot = {
      _kind: 'home-assistant',
      capturedAt: Date.now(),
      entities,
    };

    return snapshot;
  }

  private async _getEntityState(
    entityId: string
  ): Promise<HomeAssistantSnapshot['entities'][0]> {
    const url = `${this.baseUrl}/api/states/${entityId}`;

    try {
      const { statusCode, body } = await request(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
        },
        dispatcher: this.dispatcher,
        headersTimeout: 5000,
        bodyTimeout: 5000,
      });

      if (statusCode >= 400) {
        const text = await body.text();
        throw new Error(
          `${entityId}: HTTP ${statusCode} — ${text || 'no response body'}`
        );
      }

      const data = (await body.json()) as HomeAssistantEntityState;

      const isOn = data.state === 'on';
      const state = isOn ? 'on' : 'off';

      const result: HomeAssistantSnapshot['entities'][0] = {
        entityId,
        state,
      };

      if (isOn) {
        if (Array.isArray(data.attributes.rgb_color)) {
          result.rgb = data.attributes.rgb_color as [number, number, number];
        }
        if (typeof data.attributes.brightness === 'number') {
          result.brightness = data.attributes.brightness;
        }
      }

      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (
        errorMessage.includes('connect ECONNREFUSED') ||
        errorMessage.includes('ECONNREFUSED')
      ) {
        throw new Error(`${entityId}: Connection refused`);
      }
      throw err;
    }
  }

  async restore(snapshot: LightSnapshot): Promise<void> {
    if (this._closed) {
      throw new Error('HomeAssistantAdapter is closed');
    }

    const haSnapshot = snapshot as HomeAssistantSnapshot;
    if (haSnapshot._kind !== 'home-assistant') {
      throw new Error(
        `Cannot restore snapshot of kind "${haSnapshot._kind}" to HomeAssistantAdapter`
      );
    }

    await Promise.all(
      haSnapshot.entities.map((entity) => this._restoreEntity(entity))
    );
  }

  private async _restoreEntity(entity: HomeAssistantSnapshot['entities'][0]): Promise<void> {
    if (entity.state === 'off') {
      await this._turnOff(entity.entityId);
    } else if (entity.state === 'on') {
      await this._turnOn(entity.entityId, entity.rgb, entity.brightness);
    }
  }

  private async _turnOff(entityId: string): Promise<void> {
    const url = `${this.baseUrl}/api/services/light/turn_off`;
    const body = { entity_id: entityId };

    try {
      const { statusCode, body: responseBody } = await request(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        dispatcher: this.dispatcher,
        headersTimeout: 5000,
        bodyTimeout: 5000,
      });

      if (statusCode >= 400) {
        const text = await responseBody.text();
        throw new Error(
          `${entityId}: HTTP ${statusCode} — ${text || 'no response body'}`
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (
        errorMessage.includes('connect ECONNREFUSED') ||
        errorMessage.includes('ECONNREFUSED')
      ) {
        throw new Error(`${entityId}: Connection refused`);
      }
      throw err;
    }
  }

  private async _turnOn(
    entityId: string,
    rgb?: [number, number, number],
    brightness?: number
  ): Promise<void> {
    const url = `${this.baseUrl}/api/services/light/turn_on`;
    const body: any = { entity_id: entityId };

    if (Array.isArray(rgb)) {
      body.rgb_color = rgb;
    }
    if (typeof brightness === 'number') {
      body.brightness = brightness;
    }

    try {
      const { statusCode, body: responseBody } = await request(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        dispatcher: this.dispatcher,
        headersTimeout: 5000,
        bodyTimeout: 5000,
      });

      if (statusCode >= 400) {
        const text = await responseBody.text();
        throw new Error(
          `${entityId}: HTTP ${statusCode} — ${text || 'no response body'}`
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (
        errorMessage.includes('connect ECONNREFUSED') ||
        errorMessage.includes('ECONNREFUSED')
      ) {
        throw new Error(`${entityId}: Connection refused`);
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    this._closed = true;
  }
}

// ---------- Discovery + identify (setup helpers) ----------

/** Minimal connection params for setup-time Home Assistant operations (before
 *  any `entities` are chosen). */
export interface HomeAssistantConnection {
  baseUrl: string;
  token: string;
}

/** A `light.*` entity as surfaced to the setup UI. */
export interface HomeAssistantDiscoveredLight {
  /** Entity id, e.g. "light.desk_strip" (persisted in config.homeAssistant.entities). */
  entityId: string;
  /** Friendly name from the entity's attributes, falling back to the id. */
  name: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

/**
 * List every `light.*` entity Home Assistant exposes so the user can pick which
 * ones Copilot Lights should drive. Requires only the base URL + token.
 */
export async function discoverHomeAssistantLights(
  conn: HomeAssistantConnection | undefined,
  opts?: { dispatcher?: unknown }
): Promise<HomeAssistantDiscoveredLight[]> {
  if (!conn?.baseUrl || !conn?.token) {
    throw new Error('Home Assistant is not configured — set the base URL and a long-lived token first.');
  }
  const base = normalizeBaseUrl(conn.baseUrl);
  const { statusCode, body } = await request(`${base}/api/states`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${conn.token}` },
    dispatcher: opts?.dispatcher as Dispatcher | undefined,
    headersTimeout: 5000,
    bodyTimeout: 5000,
  });
  if (statusCode === 401) {
    throw new Error('Home Assistant rejected the token (401). Create a new long-lived access token.');
  }
  if (statusCode !== 200) {
    throw new Error(`Home Assistant returned status ${statusCode} listing entities.`);
  }
  const states = (await body.json()) as Array<{
    entity_id?: unknown;
    attributes?: { friendly_name?: unknown };
  }>;
  const lights: HomeAssistantDiscoveredLight[] = [];
  for (const s of Array.isArray(states) ? states : []) {
    if (typeof s.entity_id !== 'string' || !s.entity_id.startsWith('light.')) continue;
    const friendly = s.attributes?.friendly_name;
    lights.push({
      entityId: s.entity_id,
      name: typeof friendly === 'string' && friendly.length > 0 ? friendly : s.entity_id,
    });
  }
  return lights;
}

/**
 * Make a single Home Assistant light visibly blink so the user can locate it,
 * using the `light.turn_on` service with `flash: "long"`. HA restores the
 * prior state automatically after the flash.
 */
export async function blinkHomeAssistantEntity(
  conn: HomeAssistantConnection | undefined,
  entityId: string,
  opts?: { dispatcher?: unknown }
): Promise<void> {
  if (!conn?.baseUrl || !conn?.token) {
    throw new Error('Home Assistant is not configured — set the base URL and token first.');
  }
  const base = normalizeBaseUrl(conn.baseUrl);
  const { statusCode, body } = await request(`${base}/api/services/light/turn_on`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${conn.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ entity_id: entityId, flash: 'long' }),
    dispatcher: opts?.dispatcher as Dispatcher | undefined,
    headersTimeout: 5000,
    bodyTimeout: 5000,
  });
  await body.text();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Home Assistant identify failed for ${entityId}: status ${statusCode}`);
  }
}
