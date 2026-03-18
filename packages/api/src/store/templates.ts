import { randomUUID } from 'node:crypto';

export interface ScanTemplate {
  id: string;
  name: string;
  provider?: string;
  rules?: string[];
  failOn?: string;
  description?: string;
  createdAt: string;
}

interface CreateTemplateOptions {
  provider?: string;
  rules?: string[];
  failOn?: string;
  description?: string;
}

class TemplateStore {
  private templates = new Map<string, ScanTemplate>();

  create(name: string, options: CreateTemplateOptions = {}): ScanTemplate {
    const template: ScanTemplate = {
      id: randomUUID(),
      name,
      ...options,
      createdAt: new Date().toISOString(),
    };
    this.templates.set(template.id, template);
    return template;
  }

  list(): ScanTemplate[] {
    return Array.from(this.templates.values());
  }

  get(id: string): ScanTemplate | undefined {
    return this.templates.get(id);
  }

  delete(id: string): boolean {
    return this.templates.delete(id);
  }

  reset(): void {
    this.templates.clear();
  }
}

let instance: TemplateStore | null = null;

export function getTemplateStore(): TemplateStore {
  if (!instance) instance = new TemplateStore();
  return instance;
}

export function resetTemplateStore(): void {
  instance = new TemplateStore();
}
