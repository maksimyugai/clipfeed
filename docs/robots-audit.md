# Task 48-pre: robots.txt honoring audit

**Investigation only — no production behavior changed.** This measures what honoring `robots.txt`
would cost the fetcher today, using the owner's live instance data. All fetches below were read-only
`GET`s against public `robots.txt` files and the public `/api/articles` endpoint.

Methodology: `robots.txt` was parsed per RFC 9309 semantics (longest matching `Allow`/`Disallow`
pattern wins; `*` and `$` wildcards supported; an absent or unparseable file counts as fully
allowed, the standard lenient default). Real article URL paths were evaluated against each host's
`User-agent: *` group, since that's the group a fetcher with no declared bot identity falls under.

## 1. The 10 configured sources (`packages/api/sources.json`)

Each RSS feed's _article_ host was audited (not the feed subdomain itself, where different from the
article host) using 3 real article URLs pulled live from our own DB via
`GET /api/articles?source=<host>`.

| Source (id)   | Article host                     | robots.txt                     | `User-agent: *`                                                                                         | Sample articles disallowed | AI-bots singled out                                                                                                                                                                       | Crawl-delay (generic)                                                                                                                  |
| ------------- | -------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| arstechnica   | arstechnica.com                  | 200, present                   | allows all 3 sampled paths (blocks only `/wp-admin`, `/search`, `/comments`, forum-admin paths, etc.)   | 0/3                        | ClaudeBot, CCBot, Google-Extended, Bytespider, anthropic-ai, PerplexityBot → `Disallow: /`                                                                                                | none                                                                                                                                   |
| theverge      | theverge.com                     | 200, present                   | allows all 3 (blocks `/login`, `/account`, `/search`, share/highlight paths)                            | 0/3                        | GPTBot, ClaudeBot, CCBot, Google-Extended, Bytespider, anthropic-ai, PerplexityBot → `Disallow: /`                                                                                        | none                                                                                                                                   |
| simonwillison | simonwillison.net                | 200, present                   | allows all 3 (blocks only `/admin/`, `/search/`)                                                        | 0/3                        | `chatgpt-user` → `Disallow: /` (no group for GPTBot itself)                                                                                                                               | none                                                                                                                                   |
| cloudflare    | blog.cloudflare.com              | 200, present                   | allows all 2 sampled (blocks only `/_emdash/admin`, `/preview/`, `/fragments/`)                         | 0/2                        | none                                                                                                                                                                                      | none                                                                                                                                   |
| mittr         | technologyreview.com             | 200, present                   | allows all 3 (blocks only `/wp-admin/`, `*.pdf`)                                                        | 0/3                        | GPTBot, ClaudeBot, CCBot, Google-Extended, Bytespider, anthropic-ai, PerplexityBot → `Disallow: /`                                                                                        | none                                                                                                                                   |
| tomshardware  | tomshardware.com                 | 200, present                   | allows all 3 (blocks tracking/query-param/embed/infinite-scroll paths, none matching real article URLs) | 0/3                        | Bytespider, plus a long named list (ai2bot, amazonbot family, cohere, diffbot, img2dataset, kangaroo, meta-externalagent, meta-webindexer, mistralai, omgili, youbot) → all `Disallow: /` | none for `*`                                                                                                                           |
| phoronix      | phoronix.com (redirects to www.) | 200, present                   | **explicit `Allow: /`** — fully open                                                                    | 0/3                        | GPTBot, ClaudeBot, CCBot, Google-Extended, Bytespider → `Disallow: /`                                                                                                                     | none                                                                                                                                   |
| lwn           | lwn.net                          | 200, present                   | allows all 3 (blocks only `/Search`, `/ml`)                                                             | 0/3                        | GPTBot, ClaudeBot → `Disallow: /`                                                                                                                                                         | none for `*`; `Crawl-delay: 10` exists but only for named `Slurp`/`ScoutJet`, and GPTBot/ClaudeBot get a full block instead of a delay |
| servethehome  | servethehome.com (and www.)      | **404 — no robots.txt at all** | n/a (lenient default: allowed)                                                                          | 0/3 (no rules to violate)  | n/a                                                                                                                                                                                       | n/a                                                                                                                                    |
| thehackernews | thehackernews.com                | 200, present                   | allows all 3 (`Disallow:` with an empty value, i.e. explicitly disallows nothing)                       | 0/3                        | none — only a `*` group exists                                                                                                                                                            | none                                                                                                                                   |

**Result: 0 of 10 configured sources disallow generic-bot fetching of the actual article paths we
use.** This confirms the task's expectation: sites that publish an RSS feed are, unsurprisingly,
also fine with a plain GET of their own articles. The only real friction on these 10 hosts is aimed
squarely at named AI-training crawlers (see the "AI-bots singled out" column), never at a
UA-less/generic fetch.

## 2. The real long tail: HN-linked domains

The `hn` source's picks come from arbitrary third-party sites, so this is where genuine robots.txt
friction is most likely. The live instance's public `/api/articles` endpoint currently holds its
**entire corpus of ready articles — 97 total, of which 92 were `added_via: "agent"`** (no further
pages exist; `next_cursor` was `null`). All 92 agent-added articles were used (this is the full
available population, not a sample of a larger set).

Those 92 articles span **27 distinct source hosts** (well under the 40-host cap, so nothing was
truncated). Article counts per host:

| Host                          | Articles | `User-agent: *` verdict                                                                                              |
| ----------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| tomshardware.com              | 14       | allowed                                                                                                              |
| theverge.com                  | 13       | allowed                                                                                                              |
| phoronix.com                  | 12       | allowed                                                                                                              |
| arstechnica.com               | 8        | allowed                                                                                                              |
| simonwillison.net             | 7        | allowed                                                                                                              |
| thehackernews.com             | 6        | allowed                                                                                                              |
| technologyreview.com          | 5        | allowed                                                                                                              |
| lwn.net                       | 4        | allowed                                                                                                              |
| servethehome.com              | 3        | allowed (no robots.txt)                                                                                              |
| blog.cloudflare.com           | 2        | allowed                                                                                                              |
| github.com                    | 2        | allowed (disallow list is all admin/UI paths — `/pulse`, `/settings`, `/copilot/`, etc. — never plain `/owner/repo`) |
| rybakov.com                   | 1        | allowed (no `User-agent: *` group at all in its robots.txt)                                                          |
| cnn.com                       | 1        | allowed                                                                                                              |
| blog.codeberg.org             | 1        | allowed (404 — no robots.txt)                                                                                        |
| dfarq.homeip.net              | 1        | allowed                                                                                                              |
| github.blog                   | 1        | allowed                                                                                                              |
| unlayer.com                   | 1        | allowed                                                                                                              |
| cameronmpalmer.medium.com     | 1        | allowed                                                                                                              |
| late.sh                       | 1        | allowed (no `*` group)                                                                                               |
| minneapolisfed.org            | 1        | allowed                                                                                                              |
| unslop.run                    | 1        | allowed                                                                                                              |
| cursor.com                    | 1        | allowed                                                                                                              |
| magazine.sebastianraschka.com | 1        | allowed                                                                                                              |
| werd.io                       | 1        | allowed                                                                                                              |
| emergingtrajectories.com      | 1        | allowed                                                                                                              |
| **xcancel.com**               | **1**    | **DISALLOWED — blanket `Disallow: /` for `User-agent: *`**                                                           |
| fortune.com                   | 1        | allowed                                                                                                              |

**Result: 1 of 92 agent-added articles (1.1%) would have been dropped** — the single `xcancel.com`
article (a Nitter/Twitter-mirror instance that disallows its entire site to every bot, not just AI
crawlers). Every other host, including every one of the 17 genuine long-tail (non-curated-RSS)
hosts, allows a plain fetch of the article path it actually served us.

No host among all 27 audited specifies a `Crawl-delay` applicable to a generic bot. Two hosts
(`lwn.net`, `github.com`) do set a `Crawl-delay`, but each is scoped to a specific named crawler
(`Slurp`/`ScoutJet` on lwn.net, `baidu` on github.com) that a UA-less fetch would never match.

## 3. Summary numbers

| Metric                                                          | Value                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Configured sources (10) disallowing generic-bot article fetches | **0 / 10**                                                                             |
| Real agent-added articles that would be dropped                 | **1 / 92 (1.1%)**                                                                      |
| Source responsible for the 1 dropped article                    | `xcancel.com` (1/1 of its own articles; 0/91 elsewhere)                                |
| Hosts requiring `Crawl-delay` for a generic bot                 | **0 of 27** (2 hosts set one, but only for named commercial crawlers we'd never match) |

## 4. Interpretation

**What honoring robots.txt would change:** it governs _fetching_ the source page's HTML during
ingestion — nothing else. It has zero effect on publishing, summarizing, searching, or displaying an
already-ingested article; it would simply mean the pipeline skips fetching (and therefore never
adds) an article whose source host disallows it, exactly the way the existing thin-host/mirror
filters already skip certain hosts today for unrelated reasons.

**What it would NOT change:** nothing about already-published articles, Telegram posts, or the SPA.
It's a one-time gate at ingestion, not a retroactive takedown mechanism, and not something that
touches any article already in the database.

**Is the loss concentrated in the HN long tail, not the curated feeds?** Yes, unambiguously. All
measurable loss (the entire 1/92) comes from HN's long tail — a Nitter mirror that blocks
everything, not an AI-specific rule. None of the 10 curated RSS sources would lose a single article.
If the owner adopts robots.txt honoring, the practical impact is "occasionally skip a fetch from an
obscure or unusual long-tail host," not "lose curated coverage."

**Would an honest bot User-Agent cost more than robots.txt itself?** Very likely yes, based on what
was observed here — and this is a structurally different, separate risk:

- Six of the ten configured sources (arstechnica, theverge, tomshardware, phoronix, lwn, mittr)
  maintain long, actively-curated `Disallow: /` blocks for _named_ crawlers — GPTBot, ClaudeBot,
  CCBot, Bytespider, Google-Extended, anthropic-ai, PerplexityBot, plus long tails of
  commercial/AI-training bots (cohere, mistralai, diffbot, omgili, several Amazon bot variants,
  etc.) on tomshardware.com alone. This is direct evidence that these operators actively watch for
  and deliberately block _declared_ bot identities — something a fully anonymous/generic-looking
  fetch never triggers.
- robots.txt itself would not block an honestly-named ClipFeed UA on any of these hosts (a novel UA
  string doesn't match any existing named rule, so it falls under the open `*` group) — but
  publishing a UA that visibly identifies as a bot is exactly the signal that WAF/bot-management
  layers (several of these sites plausibly sit behind Cloudflare or similar, same as this project's
  own instance) use to challenge or hard-block a request _before_ robots.txt is ever consulted.
  That's a request-level block, not an ethical opt-in signal, and it isn't something this
  robots.txt-only audit can quantify — it would need separate, careful live testing (which is out of
  scope here) to measure honestly.
- In short: the sites in this audit demonstrably invest more effort blocking _declared_ bots than
  they do restricting _generic_ ones. Adopting robots.txt honoring looks cheap (≈1% article loss,
  entirely from one long-tail host); adding an honest bot UA is a separate decision with a plausibly
  much larger and currently unmeasured cost.
