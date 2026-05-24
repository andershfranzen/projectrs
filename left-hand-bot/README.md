# Left Hand

Python Discord bot for the EvilQuest server.

## Local Setup

Create a Discord application and bot in the Discord Developer Portal, name it
`Left Hand`, then put the bot token in the project root `.env`:

```env
LEFT_HAND_DISCORD_TOKEN=
LEFT_HAND_DISCORD_GUILD_ID=
```

Invite Left Hand to a server with this URL:

```text
https://discord.com/oauth2/authorize?client_id=1508123662153289948&scope=bot%20applications.commands&permissions=292057844736
```

If `LEFT_HAND_SET_NICKNAME=true`, invite with `Manage Nicknames` too:

```text
https://discord.com/oauth2/authorize?client_id=1508123662153289948&scope=bot%20applications.commands&permissions=292192062464
```

If Discord says `Private application cannot have a default authorization link`,
go to the app's **Installation** page and set **Install Link** to **None** before
turning off **Public Bot**. Discord does not allow private apps to keep the
default "Add App" authorization link.

`LEFT_HAND_DISCORD_GUILD_ID` is optional, but useful while developing because
guild-scoped slash commands sync immediately. Global commands can take longer
to appear.

Run locally:

```bash
cd left-hand-bot
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
DISCORD_TOKEN=your-token EVILQUEST_STATUS_URL=http://127.0.0.1:4000/api/status python -m left_hand_bot
```

## Docker Compose

From the project root:

```bash
docker compose up -d --build left-hand
docker compose logs -f left-hand
```

By default the compose service points the bot at the live EvilQuest API:
`https://evilquest.net`. For local dev against the host-running Bun server, set
this in the project root `.env`:

```env
LEFT_HAND_EVILQUEST_API_BASE_URL=http://host.docker.internal:4000
```

If EvilQuest is running as the compose service instead, use:

```env
LEFT_HAND_EVILQUEST_API_BASE_URL=http://evilquest:4000
```

## Commands

- `/ping` checks the bot connection.
- `/status` reports the EvilQuest online player count.
- `/online` reports the EvilQuest online player count.
- `/server` shows live API, hiscores, and online-player status.
- `/player <name>` shows a player's trained-skill hiscore stats.
- `/player <name> detail:true` shows every skill.
- `/rank <name>` shows a player's key ranks.
- `/hiscores` shows the top 10 overall hiscores.
- `/hiscores category:<category>` shows the top 10 for a skill or combat.
- `/top skill:<category>` is a shorter top-10 hiscores command.
- `/trade sell item:<item> quantity:<n> price:<text>` posts a validated sell listing.
- `/trade buy item:<item> quantity:<n> offer:<text>` posts a validated buy listing.
- `/trade search` searches recent trade listings.
- `/trade close message:<id-or-link>` closes one of your listings.
- `/trade item item:<item>` checks whether an item name is recognized.
- `/bugstats` shows bug-report thread counts.
- `/bugsearch query:<text>` searches bug-report thread titles.
- `/about` identifies the bot.

## Trading Helpers

Left Hand posts buy/sell listings into `💸│trading-post`. Item fields use
autocomplete from the EvilQuest item list and are validated before posting.

The bot reads `server/data/items.json` from a read-only Docker mount. It only
uses safe metadata for Discord: item name, whether the item stacks, and whether
it is equipment. It does not expose inventories, item values, combat stats,
drop tables, spawn data, or admin-only server state. Listings are Discord posts
only; actual item exchange still happens through the in-game trade system.

Configuration:

```env
LEFT_HAND_TRADING_POST_CHANNEL_ID=1504543318401482854
LEFT_HAND_ITEMS_PATH=/app/game-data/items.json
LEFT_HAND_TRADE_LISTING_SCAN_LIMIT=100
```

## Bug Report Automation

Left Hand watches threads under `🐛│bug-reports`. When an allowed Discord user
writes exactly `fixed`, the bot renames that thread with the `(FIXED) ` prefix.
When an allowed Discord user writes exactly `not a bug`, the bot renames that
thread with the `(NOT A BUG) ` prefix. When an allowed Discord user writes
exactly `reopen`, the bot removes either status prefix. Fixed and not-a-bug
threads are archived after the bot posts a confirmation message.

Required Discord setup:

- Enable **Message Content Intent** for the bot in the Discord Developer Portal.
- Give the bot **Manage Threads** permission in `🐛│bug-reports`.

Configuration:

```env
LEFT_HAND_BUG_REPORT_AUTOMATION_ENABLED=true
LEFT_HAND_BUG_REPORT_PARENT_CHANNEL_ID=1504718539246800896
LEFT_HAND_FIXED_AUTHOR_USER_IDS=206051525993299968,154607229364862976
LEFT_HAND_BUG_REPORT_ARCHIVE_ON_STATUS=true
LEFT_HAND_BUG_REPORT_THREAD_SCAN_LIMIT=200
```
