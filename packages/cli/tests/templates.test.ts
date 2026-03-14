import { describe, it, expect, afterEach } from 'vitest';

import {
  getAllTemplates,
  getTemplatesByCategory,
  getTemplatesByCategories,
  getTemplateById,
  listCategories,
  registerTemplate,
  unregisterTemplate,
  clearCustomTemplates,
  validateCategories,
  type PromptTemplate,
  type TemplateCategory,
} from '../templates/index';

afterEach(() => {
  clearCustomTemplates();
});

// ---------- Built-in templates ----------

describe('Templates: built-in templates', () => {
  it('should have at least 15 built-in templates', () => {
    expect(getAllTemplates().length).toBeGreaterThanOrEqual(15);
  });

  it('should cover all 5 categories', () => {
    const cats = listCategories();
    expect(cats).toContain('injection');
    expect(cats).toContain('jailbreak');
    expect(cats).toContain('bias');
    expect(cats).toContain('hallucination');
    expect(cats).toContain('pii-leakage');
  });

  it('should have at least 3 templates per category', () => {
    for (const cat of listCategories()) {
      const templates = getTemplatesByCategory(cat);
      expect(templates.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('should have unique ids', () => {
    const ids = getAllTemplates().map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should have all required fields on every template', () => {
    for (const t of getAllTemplates()) {
      expect(t.id).toBeTruthy();
      expect(t.category).toBeTruthy();
      expect(t.severity).toBeTruthy();
      expect(t.prompt_text).toBeTruthy();
      expect(t.expected_behavior).toBeTruthy();
      expect(Array.isArray(t.tags)).toBe(true);
      expect(t.tags.length).toBeGreaterThan(0);
    }
  });

  it('should have valid severity levels', () => {
    const valid = new Set(['critical', 'high', 'medium', 'low']);
    for (const t of getAllTemplates()) {
      expect(valid.has(t.severity)).toBe(true);
    }
  });
});

// ---------- Querying ----------

describe('Templates: getTemplatesByCategory', () => {
  it('should return only injection templates', () => {
    const templates = getTemplatesByCategory('injection');
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) {
      expect(t.category).toBe('injection');
    }
  });

  it('should return only pii-leakage templates', () => {
    const templates = getTemplatesByCategory('pii-leakage');
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) {
      expect(t.category).toBe('pii-leakage');
    }
  });
});

describe('Templates: getTemplatesByCategories', () => {
  it('should return templates from multiple categories', () => {
    const templates = getTemplatesByCategories(['injection', 'bias']);
    const cats = new Set(templates.map(t => t.category));
    expect(cats.has('injection')).toBe(true);
    expect(cats.has('bias')).toBe(true);
    expect(cats.has('jailbreak')).toBe(false);
  });

  it('should return all templates when all categories specified', () => {
    const all = getAllTemplates();
    const fromQuery = getTemplatesByCategories(listCategories());
    expect(fromQuery.length).toBe(all.length);
  });
});

describe('Templates: getTemplateById', () => {
  it('should find a template by id', () => {
    const t = getTemplateById('injection-001');
    expect(t).toBeDefined();
    expect(t!.category).toBe('injection');
  });

  it('should return undefined for unknown id', () => {
    expect(getTemplateById('nonexistent')).toBeUndefined();
  });
});

// ---------- Custom registration ----------

describe('Templates: custom registration', () => {
  const custom: PromptTemplate = {
    id: 'custom-001',
    category: 'injection',
    severity: 'high',
    prompt_text: 'Custom test prompt.',
    expected_behavior: 'Should handle it.',
    tags: ['custom', 'test'],
  };

  it('should register a custom template', () => {
    registerTemplate(custom);
    expect(getTemplateById('custom-001')).toBeDefined();
    expect(getAllTemplates().length).toBeGreaterThan(15);
  });

  it('should reject duplicate id', () => {
    registerTemplate(custom);
    expect(() => registerTemplate(custom)).toThrow('already exists');
  });

  it('should unregister a custom template', () => {
    registerTemplate(custom);
    expect(unregisterTemplate('custom-001')).toBe(true);
    expect(getTemplateById('custom-001')).toBeUndefined();
  });

  it('should return false for unregistering unknown template', () => {
    expect(unregisterTemplate('nonexistent')).toBe(false);
  });

  it('should clear all custom templates', () => {
    registerTemplate(custom);
    clearCustomTemplates();
    expect(getTemplateById('custom-001')).toBeUndefined();
  });
});

// ---------- Validation ----------

describe('Templates: validateCategories', () => {
  it('should return empty array for valid categories', () => {
    expect(validateCategories(['injection', 'bias', 'pii-leakage'])).toEqual([]);
  });

  it('should return unknown categories', () => {
    expect(validateCategories(['injection', 'bogus', 'bias'])).toEqual(['bogus']);
  });

  it('should return all if all unknown', () => {
    expect(validateCategories(['foo', 'bar'])).toEqual(['foo', 'bar']);
  });
});
