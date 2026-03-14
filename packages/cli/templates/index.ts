export type { PromptTemplate, TemplateCategory, TemplateSeverity } from './registry.js';
export {
  getAllTemplates,
  getTemplatesByCategory,
  getTemplatesByCategories,
  getTemplateById,
  listCategories,
  registerTemplate,
  unregisterTemplate,
  clearCustomTemplates,
  validateCategories,
} from './registry.js';
