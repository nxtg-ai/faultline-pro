import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface PackageJson {
  version?: string;
}

const packageJson = require('../package.json') as PackageJson;

export const FAULTLINE_API_VERSION = packageJson.version ?? '0.0.0';
