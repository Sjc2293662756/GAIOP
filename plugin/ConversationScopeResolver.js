'use strict';

const MAX_SCOPE_LENGTH = 1024;
const DEFAULT_ALIAS_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_ALIAS_MAX_ENTRIES = 2000;

function normalizePart(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * Resolve a conversation scope from hook-provided context only.
 * sessionKey is the stable OpenClaw scope when channel metadata is absent.
 */
function resolveConversationScopeParts(ctx = {}) {
  const sessionKey = normalizePart(ctx.sessionKey);
  const sessionScope = sessionKey && sessionKey.length <= MAX_SCOPE_LENGTH
    ? `session:${sessionKey}`
    : '';

  const parts = [ctx.channelId, ctx.accountId, ctx.conversationId].map(normalizePart);
  const rawConversationScope = parts.every(Boolean)
    ? `conversation:${parts.join(':')}`
    : '';
  const conversationScope = rawConversationScope.length <= MAX_SCOPE_LENGTH
    ? rawConversationScope
    : '';

  return { sessionScope, conversationScope };
}

function resolveConversationScope(ctx = {}) {
  const { sessionScope, conversationScope } = resolveConversationScopeParts(ctx);
  return sessionScope || conversationScope;
}

class ConversationScopeRegistry {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.maxAgeMs = Number(options.maxAgeMs) > 0
      ? Number(options.maxAgeMs)
      : DEFAULT_ALIAS_MAX_AGE_MS;
    this.maxEntries = Number(options.maxEntries) > 0
      ? Number(options.maxEntries)
      : DEFAULT_ALIAS_MAX_ENTRIES;
    this.aliases = new Map();
  }

  resolve(ctx = {}) {
    this._prune();
    const { sessionScope, conversationScope } = resolveConversationScopeParts(ctx);
    if (!sessionScope && !conversationScope) {
      return '';
    }

    const now = this.now();
    const knownSessionScope = sessionScope
      ? this.aliases.get(sessionScope)?.canonicalScope
      : '';
    const knownConversationScope = conversationScope
      ? this.aliases.get(conversationScope)?.canonicalScope
      : '';
    const canonicalScope = sessionScope
      || knownSessionScope
      || knownConversationScope
      || conversationScope;

    for (const scope of [sessionScope, conversationScope].filter(Boolean)) {
      this.aliases.set(scope, { canonicalScope, updatedAt: now });
    }
    this.aliases.set(canonicalScope, { canonicalScope, updatedAt: now });
    this._trim();
    return canonicalScope;
  }

  clearScope(scope) {
    const normalizedScope = normalizePart(scope);
    if (!normalizedScope) {
      return 0;
    }
    const canonicalScope = this.aliases.get(normalizedScope)?.canonicalScope || normalizedScope;
    let cleared = 0;
    for (const [alias, record] of this.aliases.entries()) {
      if (alias === normalizedScope || alias === canonicalScope || record.canonicalScope === canonicalScope) {
        this.aliases.delete(alias);
        cleared += 1;
      }
    }
    return cleared;
  }

  _prune() {
    const now = this.now();
    for (const [alias, record] of this.aliases.entries()) {
      if ((now - Number(record.updatedAt || 0)) > this.maxAgeMs) {
        this.aliases.delete(alias);
      }
    }
  }

  _trim() {
    while (this.aliases.size > this.maxEntries) {
      this.aliases.delete(this.aliases.keys().next().value);
    }
  }
}

module.exports = {
  ConversationScopeRegistry,
  resolveConversationScope,
  resolveConversationScopeParts,
  normalizePart
};
