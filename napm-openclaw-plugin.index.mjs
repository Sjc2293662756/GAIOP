import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pluginModule = require('./index.js');

const plugin = pluginModule?.default || pluginModule;

export const register = plugin.register.bind(plugin);
export const id = plugin.id;
export const name = plugin.name;
export const description = plugin.description;

export default plugin;
