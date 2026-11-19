// The Worker's entry point; the logic is in watcher.ts.
import { health, run, type Env } from "./watcher.ts";

export default {
  async scheduled(controller: { cron: string; scheduledTime: number }, env: Env): Promise<void> {
    await run(controller.cron, env, new Date(controller.scheduledTime));
  },
  fetch: (req: Request, env: Env) => health(req, env),
};
