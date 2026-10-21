// The sharing site's revoker: a Worker with no route, only a once-a-minute cron. It
// runs the follow-up sign-outs that removing a guest queues in KV, so they
// happen even if the Share screen tab is closed or share.mjs is interrupted.
// publish-pages.mjs deploys it alongside a sharing site; its API token is the
// secret ACCESS_API_TOKEN (the same Access-only token as the Share helper).

import { AccessClient, runDueRevokes } from "./access.mjs";

export default {
  async scheduled(_event, env) {
    const client = new AccessClient({ token: env.ACCESS_API_TOKEN, accountId: env.ACCOUNT_ID });
    await runDueRevokes(env.LINKS, client);
  },
};
