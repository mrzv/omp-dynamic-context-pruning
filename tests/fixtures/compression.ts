import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { buildCompressionSearchContext } from "../../src/compress/search.ts";
import { assignStableReferences } from "../../src/messages/identity.ts";
import { buildLogicalMessages } from "../../src/messages/logical-messages.ts";
import { createRuntimeState } from "../../src/state/runtime.ts";

export function compressionContext(messages: AgentMessage[]) {
  const entryIds = messages.map((_, index) => `entry-${index + 1}`);
  const groups = buildLogicalMessages(messages, entryIds);
  const state = createRuntimeState();
  assignStableReferences(groups, state.references);
  const search = buildCompressionSearchContext(state, groups);
  return { groups, state, search };
}
