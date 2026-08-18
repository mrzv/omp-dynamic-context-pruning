import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerDynamicContextPruning } from "./extension.ts";

export default function dynamicContextPruning(pi: ExtensionAPI): void {
  registerDynamicContextPruning(pi);
}
