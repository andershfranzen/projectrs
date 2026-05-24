from __future__ import annotations

import asyncio
import logging
from typing import Any

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands

from .config import Settings, load_settings

LOGGER = logging.getLogger("left_hand")


class LeftHandBot(commands.Bot):
    def __init__(self, settings: Settings) -> None:
        intents = discord.Intents.default()
        super().__init__(command_prefix=commands.when_mentioned, intents=intents)
        self.settings = settings
        self.status_client: aiohttp.ClientSession | None = None

    async def setup_hook(self) -> None:
        self.status_client = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=5),
            headers={"User-Agent": "Left Hand Discord Bot"},
        )

        if not self.settings.sync_commands:
            LOGGER.info("Slash command sync disabled")
            return

        if self.settings.discord_guild_id is not None:
            guild = discord.Object(id=self.settings.discord_guild_id)
            self.tree.copy_global_to(guild=guild)
            commands_synced = await self.tree.sync(guild=guild)
            LOGGER.info("Synced %s slash command(s) to guild %s", len(commands_synced), guild.id)
            return

        commands_synced = await self.tree.sync()
        LOGGER.info("Synced %s global slash command(s)", len(commands_synced))

    async def on_ready(self) -> None:
        await self.change_presence(activity=discord.Game(name="EvilQuest"))
        if self.settings.set_nickname:
            await self._apply_nickname()

        user = self.user
        LOGGER.info("Left Hand is online as %s (%s)", user, getattr(user, "id", "unknown"))

    async def close(self) -> None:
        if self.status_client is not None:
            await self.status_client.close()
        await super().close()

    async def fetch_evilquest_status(self) -> dict[str, Any]:
        if self.status_client is None:
            raise RuntimeError("Status HTTP client is not ready.")

        async with self.status_client.get(self.settings.evilquest_status_url) as response:
            response.raise_for_status()
            data = await response.json()
            if not isinstance(data, dict):
                raise RuntimeError("EvilQuest status response was not an object.")
            return data

    async def _apply_nickname(self) -> None:
        for guild in self.guilds:
            member = guild.me
            if member is None or member.nick == self.settings.nickname:
                continue
            try:
                await member.edit(nick=self.settings.nickname, reason="Configure Left Hand display name")
            except discord.Forbidden:
                LOGGER.info("Missing permission to set nickname in guild %s", guild.id)
            except discord.HTTPException:
                LOGGER.exception("Failed to set nickname in guild %s", guild.id)


def register_commands(bot: LeftHandBot) -> None:
    @bot.tree.command(name="ping", description="Check whether Left Hand is online.")
    async def ping(interaction: discord.Interaction) -> None:
        latency_ms = round(bot.latency * 1000)
        await interaction.response.send_message(f"Pong. Gateway latency: {latency_ms} ms.")

    @bot.tree.command(name="status", description="Show the current EvilQuest server status.")
    async def status(interaction: discord.Interaction) -> None:
        await interaction.response.defer(thinking=True)
        try:
            data = await bot.fetch_evilquest_status()
        except Exception:
            LOGGER.exception("Failed to fetch EvilQuest status")
            await interaction.followup.send("EvilQuest status is unavailable right now.")
            return

        online_players = data.get("onlinePlayers")
        if not isinstance(online_players, int):
            await interaction.followup.send("EvilQuest status returned an unexpected response.")
            return

        noun = "player" if online_players == 1 else "players"
        await interaction.followup.send(f"EvilQuest is online with {online_players} {noun}.")

    @bot.tree.command(name="about", description="Show what Left Hand is.")
    async def about(interaction: discord.Interaction) -> None:
        await interaction.response.send_message("Left Hand is the EvilQuest Discord bot.")


async def run_bot() -> None:
    settings = load_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    bot = LeftHandBot(settings)
    register_commands(bot)

    async with bot:
        await bot.start(settings.discord_token)


def main() -> None:
    try:
        asyncio.run(run_bot())
    except KeyboardInterrupt:
        LOGGER.info("Left Hand stopped")

