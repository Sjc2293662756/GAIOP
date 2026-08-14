import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let plugin;
try {
  plugin = require('./index.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
  plugin = require('./napm-openclaw-plugin.remote.js');
}
const resolvedPlugin = plugin?.default || plugin;

export const id = resolvedPlugin.id;
export const name = resolvedPlugin.name;
export const description = resolvedPlugin.description;
export const register = resolvedPlugin.register?.bind(resolvedPlugin);

export default resolvedPlugin;
