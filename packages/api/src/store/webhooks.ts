import { createHmac, randomBytes, randomUUID } from 'node:crypto';

export type WebhookEvent = 'scan.complete' | 'scan.failed';

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  secret: string;
  createdAt: string;
}

export type WebhookPublic = Omit<Webhook, 'secret'>;

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  data: unknown;
}

// ─── Sleep / backoff engine ────────────────────────────────────────────────

type SleepFn = (ms: number) => Promise<void>;
let _sleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function _setSleepFn(fn: SleepFn): void { _sleep = fn; }

const RETRY_DELAYS = [0, 500, 1000]; // ms before each of the 3 attempts

// ─── HMAC signing ──────────────────────────────────────────────────────────

function signPayload(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

// ─── WebhookStore ──────────────────────────────────────────────────────────

class WebhookStore {
  private webhooks: Webhook[] = [];

  create(url: string, events: WebhookEvent[], secret?: string): Webhook {
    const entry: Webhook = {
      id: randomUUID(),
      url,
      events,
      secret: secret ?? randomBytes(32).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    this.webhooks.push(entry);
    return entry;
  }

  list(): WebhookPublic[] {
    return this.webhooks.map(({ secret: _secret, ...rest }) => rest);
  }

  delete(id: string): boolean {
    const idx = this.webhooks.findIndex((w) => w.id === id);
    if (idx === -1) return false;
    this.webhooks.splice(idx, 1);
    return true;
  }

  getByEvent(event: WebhookEvent): Webhook[] {
    return this.webhooks.filter((w) => w.events.includes(event));
  }
}

let instance: WebhookStore | null = null;

export function getWebhookStore(): WebhookStore {
  if (!instance) instance = new WebhookStore();
  return instance;
}

export function resetWebhookStore(): void {
  instance = new WebhookStore();
}

// ─── Dispatch ──────────────────────────────────────────────────────────────

export async function dispatchWebhook(
  webhook: Webhook,
  event: WebhookEvent,
  data: unknown,
  timestamp?: string,
): Promise<void> {
  const payload: WebhookPayload = {
    event,
    timestamp: timestamp ?? new Date().toISOString(),
    data,
  };
  const body = JSON.stringify(payload);
  const signature = signPayload(body, webhook.secret);

  for (let attempt = 0; attempt < 3; attempt++) {
    await _sleep(RETRY_DELAYS[attempt]);
    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Faultline-Signature': signature,
        },
        body,
      });
      if (res.ok) return;
    } catch {
      // network error — retry or swallow
    }
  }
  // All 3 attempts exhausted — swallow silently
}

export function fireWebhookEvent(event: WebhookEvent, data: unknown): void {
  const targets = getWebhookStore().getByEvent(event);
  if (targets.length === 0) return;
  const timestamp = new Date().toISOString();
  for (const webhook of targets) {
    void dispatchWebhook(webhook, event, data, timestamp);
  }
}
