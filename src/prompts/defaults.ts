export type PromptName =
  | "system"
  | "compress-range"
  | "compress-message"
  | "context-limit-nudge"
  | "turn-nudge"
  | "iteration-nudge";

export const SYSTEM_PROMPT = `You operate in a context-constrained environment. Manage context continuously to avoid buildup and preserve retrieval quality. Efficient context management is paramount for your agentic performance.

The ONLY tool you have for context management is \`compress\`. It replaces older conversation content with technical summaries you produce.

\`<dcp-message-id>\` and \`<dcp-system-reminder>\` tags are environment-injected metadata. Do not output them.

THE PHILOSOPHY OF COMPRESS
\`compress\` transforms conversation content into dense, high-fidelity summaries. This is not cleanup - it is crystallization. Your summary becomes the authoritative record of what transpired.

Think of compression as phase transitions: raw exploration becomes refined understanding. The original context served its purpose; your summary now carries that understanding forward.

COMPRESS WHEN
A section is genuinely closed and the raw conversation has served its purpose:
- Research concluded and findings are clear
- Implementation finished and verified
- Exploration exhausted and patterns understood
- Dead-end noise can be discarded without waiting for a whole chapter to close

DO NOT COMPRESS IF
- Raw context is still relevant and needed for edits or precise references
- The target content is still actively in progress
- You may need exact code, error messages, or file contents in the immediate next steps

Before compressing, ask: \"Is this section closed enough to become summary-only right now?\"

Evaluate conversation signal-to-noise regularly. Use \`compress\` deliberately with quality-first summaries.`;

export const COMPRESS_RANGE_PROMPT = `Collapse a range in the conversation into a detailed summary.

Your summary must be exhaustive but lean. Preserve file paths, function signatures, decisions, constraints, findings, tool outcomes, and user intent. Directly quote short user instructions when that best preserves exact meaning.

BOUNDARY IDS
- \`mNNNN\` identifies one raw logical message.
- \`bN\` identifies one previously compressed block.
- Pick IDs only from injected \`<dcp-message-id>\` tags visible in context.
- Start must appear before end.
- Do not invent IDs.

COMPRESSED BLOCK PLACEHOLDERS
When the range includes earlier blocks, include each required placeholder exactly once as \`(bN)\`. Placeholders are expanded to the stored summaries. Do not emit \`(bN)\` except as an intentional placeholder.

BATCHING
Send multiple non-overlapping ranges in one call. Each entry needs \`startId\`, \`endId\`, and \`summary\`.`;

export const COMPRESS_MESSAGE_PROMPT = `Collapse selected individual logical messages into detailed summaries.

Preserve file paths, signatures, decisions, constraints, findings, tool outcomes, and user intent. A tool-call assistant message and all of its paired tool results are one logical message.

MESSAGE IDS
- Select only visible \`mNNNN\` IDs.
- Ignore XML attributes when copying an ID.
- Messages marked \`BLOCKED\` cannot be compressed.
- The priority attribute indicates relative context cost; prefer closed high-priority messages.
- Do not invent IDs.

Batch many safe messages in one call. Each entry summarizes exactly one logical message. Keep active instructions, unresolved questions, and recent working context verbatim.`;

export const CONTEXT_LIMIT_NUDGE = `<dcp-system-reminder>
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED

You are at or beyond the configured max context threshold. Use the compress tool now. Finish only an immediately critical atomic step first. Select older resolved history, avoid the active frontier, and preserve all essential details and user intent.
</dcp-system-reminder>`;

export const TURN_NUDGE = `<dcp-system-reminder>
Evaluate the conversation for closed, stale logical messages. Compress them if their raw form is no longer needed. Keep active context verbatim.
</dcp-system-reminder>`;

export const ITERATION_NUDGE = `<dcp-system-reminder>
You have been iterating for a while since the last user message. Compress any closed portion that is unlikely to be referenced immediately.
</dcp-system-reminder>`;

export const DEFAULT_PROMPTS: Record<PromptName, string> = {
  system: SYSTEM_PROMPT,
  "compress-range": COMPRESS_RANGE_PROMPT,
  "compress-message": COMPRESS_MESSAGE_PROMPT,
  "context-limit-nudge": CONTEXT_LIMIT_NUDGE,
  "turn-nudge": TURN_NUDGE,
  "iteration-nudge": ITERATION_NUDGE,
};
