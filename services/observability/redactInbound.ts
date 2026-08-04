/**
 * Redaction for inbound WebSocket frames that get logged at `warn`.
 *
 * Two receive-path logs print the frame itself: the server's rejection of a
 * write, and any inbound payload we do not recognise. Both were written while
 * the logger was dead in release builds, so they dumped the whole frame —
 * fine on a developer's machine, not fine now that `warn` reaches real
 * devices. Frame bodies are encrypted, so the exposure is routing metadata
 * (inbox addresses, ids) rather than message text, but that metadata is the
 * social graph and does not belong in a device log.
 *
 * The rule is allowlist, not blocklist: a field prints its value only if it
 * is named below. Anything unrecognised prints its type and size instead. A
 * new field the server starts sending is therefore redacted by default, which
 * is the safe direction for a rule nobody will revisit.
 *
 * Shapes still survive, which is what these two logs are actually for: an
 * unhandled frame reports its key names and their types, enough to identify
 * the shape the server answered with.
 *
 * FULL-FIDELITY CAPTURES: the DM/transport rig needs the entire frame, and
 * that is what the never-merged diag branch is for. It overrides this one
 * function to return `JSON.stringify(message)` — a three-line diff in a file
 * nothing else imports, so it rebases onto this branch cleanly instead of
 * conflicting inside the receive path. Do not relax the rule here to save
 * the rig a diff.
 */

/** Server-generated scalars, safe to print as-is. */
const VERBATIM_FIELDS = new Set([
  'error',
  'type',
  'status',
  'code',
  'reason',
  'timestamp',
  'seq',
  'has_more',
]);

/** Addresses and ids: enough prefix to correlate two log lines, no more. */
const TRUNCATED_FIELDS = new Set([
  'address',
  'inboxAddress',
  'inbox_address',
  'hub_address',
  'senderAddress',
  'sender_address',
  'conversationId',
  'messageId',
  'spaceId',
]);

const ID_PREFIX = 12;
const MAX_FIELD = 120;
const MAX_TOTAL = 400;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Type and size of a value we are not willing to print. */
function shapeOf(value: unknown): string {
  if (value === null) return '<null>';
  if (Array.isArray(value)) return `<array:${value.length}>`;
  if (typeof value === 'string') return `<string:${value.length}>`;
  if (typeof value === 'object') return `<object:${Object.keys(value as object).length}>`;
  return `<${typeof value}>`;
}

/**
 * A loggable one-line summary of an inbound frame. Never returns message
 * content, an untruncated address, or key material.
 */
export function summarizeInbound(message: unknown): string {
  if (message === null || typeof message !== 'object') {
    return truncate(String(message), MAX_FIELD);
  }

  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (VERBATIM_FIELDS.has(key)) {
      // Allowlisting the NAME does not allowlist arbitrary nested content: a
      // server is free to answer `error: { code, inbox, detail }`, and passing
      // that object through would serialise every field inside it, addresses
      // included. Only primitives print; a structured value falls back to its
      // shape like any unrecognised field.
      if (typeof value === 'string') {
        summary[key] = truncate(value, MAX_FIELD);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        summary[key] = value;
      } else {
        summary[key] = shapeOf(value);
      }
    } else if (TRUNCATED_FIELDS.has(key)) {
      summary[key] = truncate(String(value), ID_PREFIX);
    } else {
      summary[key] = shapeOf(value);
    }
  }

  return truncate(JSON.stringify(summary), MAX_TOTAL);
}
