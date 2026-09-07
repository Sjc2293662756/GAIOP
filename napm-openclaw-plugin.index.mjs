import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const indexPath = fileURLToPath(new URL('./index.js', import.meta.url));
const remotePath = fileURLToPath(new URL('./napm-openclaw-plugin.remote.js', import.meta.url));

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

const indexHash = sha256(indexPath);
const remoteHash = sha256(remotePath);
if (indexHash !== remoteHash) {
  throw new Error(`NAPM plugin entrypoint mismatch: index.js=${indexHash} remote.js=${remoteHash}`);
}

const plugin = require(indexPath);
const resolvedPlugin = plugin?.default || plugin;

export const id = resolvedPlugin.id;
export const name = resolvedPlugin.name;
export const description = resolvedPlugin.description;
export const register = resolvedPlugin.register?.bind(resolvedPlugin);

export default resolvedPlugin;
