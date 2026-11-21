# site-watch

Watches a web shop from outside its hosting and writes to a Telegram chat:

- when the site stops working — the reason and what to do; again every 6 hours while it lasts;
  and when it works again, with how long it was down;
- the day before the hosting is charged;
- 30, 7 and 1 day before the domain's registration runs out.

It has to live outside the site: a shop's own notifications run inside the shop, and go silent
with it when its hosting switches it off.

`watch.mjs` has no dependencies (Node 20+). Which site, which chat and every name in the
messages are settings (repository secrets), listed at the top of the file. `state.json` is what
it remembers between runs.

    SITE_URL=https://example.com DRY_RUN=1 node watch.mjs   # look at a site, print what would be sent
