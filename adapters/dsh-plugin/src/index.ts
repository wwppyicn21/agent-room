import { Config, type PluginConfig } from "./config.js";
import { RoomBridge, type DshContextLike } from "./bridge.js";

export const name = "agent-room";
export const inject = ["sessionController", "sessionQuery"];
export { Config, RoomBridge };
export type { BridgeStatus } from "./bridge.js";

/**
 * Cordis entry point. The Room SDK owns authentication, leases and acks; this
 * plugin owns mapping, prompt construction, output extraction and recovery.
 */
export function apply(ctx: DshContextLike, config: Partial<PluginConfig>): void {
  const bridge = new RoomBridge(config, { ctx });
  ctx.effect(() => {
    bridge.start().catch((error: unknown) => {
      ctx.logger.error(
        `agent-room: start failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    });
    return () => {
      void bridge.stop();
    };
  });
}

export default { name, inject, Config, apply };
