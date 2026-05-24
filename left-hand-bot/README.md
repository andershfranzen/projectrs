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
https://discord.com/oauth2/authorize?client_id=1508123662153289948&scope=bot%20applications.commands&permissions=2048
```

If `LEFT_HAND_SET_NICKNAME=true`, invite with `Manage Nicknames` too:

```text
https://discord.com/oauth2/authorize?client_id=1508123662153289948&scope=bot%20applications.commands&permissions=134219776
```

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

The compose service sets `EVILQUEST_STATUS_URL` to
`http://evilquest:4000/api/status`, so the bot can read the game status over
the internal Docker network.

## Commands

- `/ping` checks the bot connection.
- `/status` reports the EvilQuest online player count.
- `/about` identifies the bot.
