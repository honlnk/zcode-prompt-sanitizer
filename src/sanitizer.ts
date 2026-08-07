import type { RewriteRule, RewriteScope, StatsMap } from './types.js';

/**
 * Result of rewriting a request body.
 */
export interface RewriteResult {
  /** Whether the body was mutated. */
  changed: boolean;
  /** Mutated JSON-serializable body (same shape as input when unchanged). */
  body: unknown;
  /** Rule ids that fired during this pass. */
  firedRuleIds: string[];
}

/**
 * Sanitizer applies ordered rewrite rules to chat completion request bodies.
 *
 * Design:
 *  - Only OpenAI-style `messages[].content` is rewritten.
 *  - Rules match by exact substring (String.indexOf); replacement is literal.
 *  - `content` may be a string OR an array of content parts (vision style);
 *    both shapes are handled. Non-string content (e.g. image_url) is skipped.
 *  - Stats are recorded per rule id for the dashboard.
 */
export class Sanitizer {
  private stats: StatsMap = {};

  constructor(private rules: RewriteRule[]) {
    this.resetStats();
  }

  setRules(rules: RewriteRule[]): void {
    this.rules = rules;
    // Preserve existing counters for still-present rules; reset removed ones.
    const next: StatsMap = {};
    for (const r of rules) {
      next[r.id] = this.stats[r.id] ?? { matches: 0, lastMatchedAt: null };
    }
    this.stats = next;
  }

  getStats(): StatsMap {
    return structuredClone(this.stats);
  }

  resetStats(): void {
    this.stats = {};
    for (const r of this.rules) {
      this.stats[r.id] = { matches: 0, lastMatchedAt: null };
    }
  }

  /**
   * Rewrite the given parsed request body in place. Returns a description of
   * what changed. Bodies without a `messages` array are returned unchanged.
   */
  rewrite(body: unknown): RewriteResult {
    const fired: string[] = [];
    if (!body || typeof body !== 'object') {
      return { changed: false, body, firedRuleIds: fired };
    }
    const obj = body as Record<string, unknown>;
    const messages = obj.messages;
    if (!Array.isArray(messages)) {
      return { changed: false, body, firedRuleIds: fired };
    }

    let changed = false;
    const activeRules = this.rules.filter((r) => r.enabled && r.match.length > 0);

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const role = (msg as { role?: unknown }).role;
      const content = (msg as { content?: unknown }).content;
      if (typeof content === 'string') {
        const res = this.applyRulesToString(content, role, activeRules);
        if (res.changed) {
          (msg as { content?: unknown }).content = res.value;
          changed = true;
          for (const id of res.fired) {
            if (!fired.includes(id)) fired.push(id);
          }
        }
      } else if (Array.isArray(content)) {
        // OpenAI vision/multipart content: [{type:"text", text:"..."}, ...]
        let partChanged = false;
        const newContent = content.map((part) => {
          if (
            part &&
            typeof part === 'object' &&
            (part as { type?: unknown }).type === 'text' &&
            typeof (part as { text?: unknown }).text === 'string'
          ) {
            const res = this.applyRulesToString(
              (part as { text: string }).text,
              role,
              activeRules,
            );
            if (res.changed) {
              partChanged = true;
              for (const id of res.fired) {
                if (!fired.includes(id)) fired.push(id);
              }
              return { ...part, text: res.value };
            }
          }
          return part;
        });
        if (partChanged) {
          (msg as { content?: unknown }).content = newContent;
          changed = true;
        }
      }
    }

    return { changed, body, firedRuleIds: fired };
  }

  private applyRulesToString(
    value: string,
    role: unknown,
    rules: RewriteRule[],
  ): { changed: boolean; value: string; fired: string[] } {
    let current = value;
    let changed = false;
    const fired: string[] = [];
    for (const rule of rules) {
      if (!rule.scopes.includes(role as RewriteScope)) continue;
      if (!current.includes(rule.match)) continue;
      // Count occurrences for accuracy; loop to replace all.
      let count = 0;
      if (rule.replacement.length === 0) {
        // Simple delete-all via split/join (faster than regex with special chars).
        const parts = current.split(rule.match);
        count = parts.length - 1;
        current = parts.join('');
      } else {
        let idx = current.indexOf(rule.match);
        let built = '';
        let last = 0;
        while (idx !== -1) {
          count++;
          built += current.slice(last, idx) + rule.replacement;
          last = idx + rule.match.length;
          idx = current.indexOf(rule.match, last);
        }
        built += current.slice(last);
        current = built;
      }
      if (count > 0) {
        changed = true;
        fired.push(rule.id);
        this.bumpStat(rule.id, count);
      }
    }
    return { changed, value: current, fired };
  }

  private bumpStat(id: string, by: number): void {
    const cur = this.stats[id] ?? { matches: 0, lastMatchedAt: null };
    cur.matches += by;
    cur.lastMatchedAt = new Date().toISOString();
    this.stats[id] = cur;
  }
}
