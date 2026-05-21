import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pluginModule = require('./index.js');

const plugin = pluginModule?.default || pluginModule;

export default plugin;
