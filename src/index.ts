import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function dynamicContextPruning(pi: ExtensionAPI): void {
  pi.setLabel("Dynamic Context Pruning");
  pi.on("session_start", async (_event, context) => {
    context.ui.setStatus("dcp", "DCP");
  });
  pi.on("session_shutdown", async (_event, context) => {
    context.ui.setStatus("dcp", undefined);
  });
}
