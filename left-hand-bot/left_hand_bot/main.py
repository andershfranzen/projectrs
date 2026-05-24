from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import logging
import re
from collections.abc import AsyncIterator
from urllib.parse import urlencode
from typing import Any

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands

from .config import Settings, load_settings

LOGGER = logging.getLogger("left_hand")

HISCORE_CATEGORY_CHOICES = [
    app_commands.Choice(name="Overall", value="overall"),
    app_commands.Choice(name="Combat", value="combat"),
    app_commands.Choice(name="Accuracy", value="accuracy"),
    app_commands.Choice(name="Strength", value="strength"),
    app_commands.Choice(name="Defence", value="defence"),
    app_commands.Choice(name="Hitpoints", value="hitpoints"),
    app_commands.Choice(name="Archery", value="archery"),
    app_commands.Choice(name="Good Magic", value="goodmagic"),
    app_commands.Choice(name="Evil Magic", value="evilmagic"),
    app_commands.Choice(name="Woodcut", value="woodcut"),
    app_commands.Choice(name="Fishing", value="fishing"),
    app_commands.Choice(name="Cooking", value="cooking"),
    app_commands.Choice(name="Mining", value="mining"),
    app_commands.Choice(name="Smithing", value="smithing"),
    app_commands.Choice(name="Crafting", value="crafting"),
    app_commands.Choice(name="Roguery", value="roguery"),
]

PRIMARY_PROFILE_CATEGORIES = {"overall", "combat"}
FIXED_THREAD_PREFIX = "(FIXED) "
NOT_A_BUG_THREAD_PREFIX = "(NOT A BUG) "
BUG_THREAD_STATUS_PREFIX_RE = re.compile(
    r"^\s*(?:\((?:fixed|not\s+a\s+bug)\)|\[(?:fixed|not\s+a\s+bug)\])\s*",
    re.IGNORECASE,
)
BUG_SEARCH_MAX_RESULTS = 10


def format_number(value: Any) -> str:
    if isinstance(value, bool) or not isinstance(value, int):
        return "0"
    return f"{value:,}"


def as_int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def category_name(category: Any) -> str:
    if isinstance(category, dict) and isinstance(category.get("name"), str):
        return category["name"]
    return "Unknown"


def category_id(category: Any) -> str:
    if isinstance(category, dict) and isinstance(category.get("id"), str):
        return category["id"]
    return ""


def hiscore_row_line(row: dict[str, Any]) -> str:
    rank = as_int(row.get("rank"))
    username = str(row.get("username") or "Unknown")
    level = as_int(row.get("level"))
    xp = format_number(row.get("xp"))
    daily_xp = as_int(row.get("dailyXp"))
    daily = f" (+{daily_xp:,} today)" if daily_xp > 0 else ""
    return f"#{rank} {username} - level {level}, {xp} XP{daily}"


def profile_row_line(row: dict[str, Any]) -> str:
    rank = as_int(row.get("rank"))
    level = as_int(row.get("level"))
    xp = format_number(row.get("xp"))
    daily_xp = as_int(row.get("dailyXp"))
    daily = f", +{daily_xp:,} today" if daily_xp > 0 else ""
    return f"Rank #{rank} - level {level}, {xp} XP{daily}"


def rank_row_line(row: dict[str, Any]) -> str:
    rank = as_int(row.get("rank"))
    level = as_int(row.get("level"))
    xp = format_number(row.get("xp"))
    daily_xp = as_int(row.get("dailyXp"))
    daily = f", +{daily_xp:,} today" if daily_xp > 0 else ""
    return f"#{rank} - level {level}, {xp} XP{daily}"


def is_trained_profile_row(row: dict[str, Any]) -> bool:
    return as_int(row.get("level")) > 1 or as_int(row.get("xp")) > 0 or as_int(row.get("dailyXp")) > 0


def visible_profile_rows(rows: list[dict[str, Any]], detail: bool) -> list[dict[str, Any]]:
    if detail:
        return rows
    return [
        row
        for row in rows
        if category_id(row.get("category")) in PRIMARY_PROFILE_CATEGORIES or is_trained_profile_row(row)
    ]


def build_player_embed(username: str, rows: list[dict[str, Any]], detail: bool) -> discord.Embed:
    primary_lines: list[str] = []
    skill_lines: list[str] = []
    for row in visible_profile_rows(rows, detail):
        cat = row.get("category")
        line = profile_row_line(row)
        if category_id(cat) in PRIMARY_PROFILE_CATEGORIES:
            primary_lines.append(f"**{category_name(cat)}:** {line}")
        else:
            skill_lines.append(f"**{category_name(cat)}:** {line}")

    embed = discord.Embed(title=f"{username} Stats", color=discord.Color.dark_gold())
    embed.add_field(name="Summary", value="\n".join(primary_lines) or "No summary stats.", inline=False)

    if skill_lines:
        midpoint = (len(skill_lines) + 1) // 2
        embed.add_field(name="Skills", value="\n".join(skill_lines[:midpoint]), inline=True)
        embed.add_field(name="\u200b", value="\n".join(skill_lines[midpoint:]) or "\u200b", inline=True)
    elif not detail:
        embed.add_field(name="Skills", value="No trained skills yet.", inline=False)

    if not detail:
        embed.set_footer(text="Use detail:true to show every skill.")
    return embed


def build_rank_embed(username: str, rows: list[dict[str, Any]]) -> discord.Embed:
    lines: list[str] = []
    for row in visible_profile_rows(rows, detail=False):
        cat = row.get("category")
        lines.append(f"**{category_name(cat)}:** {rank_row_line(row)}")

    return discord.Embed(
        title=f"{username} Ranks",
        description="\n".join(lines) or "No ranked stats yet.",
        color=discord.Color.dark_gold(),
    )


def build_online_message(online_players: int) -> str:
    noun = "player" if online_players == 1 else "players"
    return f"EvilQuest has {online_players} {noun} online."


def thread_jump_url(thread: discord.Thread) -> str:
    return f"https://discord.com/channels/{thread.guild.id}/{thread.id}"


def bug_thread_status(thread_name: str) -> str:
    lowered = thread_name.strip().lower()
    if lowered.startswith("(fixed)") or lowered.startswith("[fixed]"):
        return "fixed"
    if lowered.startswith("(not a bug)") or lowered.startswith("[not a bug]"):
        return "not_a_bug"
    return "open"


class LeftHandBot(commands.Bot):
    def __init__(self, settings: Settings) -> None:
        intents = discord.Intents.default()
        intents.message_content = settings.bug_report_automation_enabled
        super().__init__(command_prefix=commands.when_mentioned, intents=intents)
        self.settings = settings
        self.status_client: aiohttp.ClientSession | None = None

    async def setup_hook(self) -> None:
        self.status_client = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=15, connect=10),
            headers={"User-Agent": "Left Hand Discord Bot"},
        )

        if not self.settings.sync_commands:
            LOGGER.info("Slash command sync disabled")
            return

        if self.settings.discord_guild_id is not None:
            guild = discord.Object(id=self.settings.discord_guild_id)
            self.tree.copy_global_to(guild=guild)
            try:
                commands_synced = await self.tree.sync(guild=guild)
            except discord.Forbidden:
                LOGGER.warning(
                    "Could not sync slash commands to guild %s. Invite Left Hand to that server with "
                    "the bot and applications.commands scopes, then restart the service.",
                    guild.id,
                )
                return
            LOGGER.info("Synced %s slash command(s) to guild %s", len(commands_synced), guild.id)
            return

        try:
            commands_synced = await self.tree.sync()
        except discord.Forbidden:
            LOGGER.warning("Could not sync global slash commands. Check the bot token and application permissions.")
            return
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
        return await self.fetch_evilquest_json_url(self.settings.evilquest_status_url)

    async def fetch_evilquest_json(self, path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
        query = f"?{urlencode(params)}" if params else ""
        url = f"{self.settings.evilquest_api_base_url}{path}{query}"
        return await self.fetch_evilquest_json_url(url)

    async def fetch_evilquest_json_url(self, url: str) -> dict[str, Any]:
        if self.status_client is None:
            raise RuntimeError("EvilQuest HTTP client is not ready.")

        async with self.status_client.get(url) as response:
            response.raise_for_status()
            data = await response.json()
            if not isinstance(data, dict):
                raise RuntimeError("EvilQuest response was not an object.")
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

    async def on_message(self, message: discord.Message) -> None:
        await self.process_commands(message)
        if not self.settings.bug_report_automation_enabled:
            return

        if should_mark_bug_thread_fixed(message, self.settings):
            await self._set_bug_thread_status(message, FIXED_THREAD_PREFIX, "Marked fixed")
            return

        if should_mark_bug_thread_not_a_bug(message, self.settings):
            await self._set_bug_thread_status(message, NOT_A_BUG_THREAD_PREFIX, "Marked not a bug")
            return

        if should_reopen_bug_thread(message, self.settings):
            await self._reopen_bug_thread(message)

    async def _set_bug_thread_status(self, message: discord.Message, prefix: str, reason_action: str) -> None:
        thread = message.channel
        if not isinstance(thread, discord.Thread):
            return
        if thread.name.startswith(prefix):
            await thread.send(f"{reason_action}.")
            if self.settings.bug_report_archive_on_status and not thread.archived:
                await self._archive_bug_thread(thread, reason_action)
            return
        updated_name = f"{prefix}{remove_bug_thread_status_prefix(thread.name)}"

        try:
            await thread.edit(
                name=updated_name,
                reason=f"{reason_action} by {message.author}",
            )
            await thread.send(f"{reason_action}.")
            if self.settings.bug_report_archive_on_status:
                await self._archive_bug_thread(thread, reason_action)
            LOGGER.info("%s for bug thread %s after message from %s", reason_action, thread.id, message.author)
        except discord.Forbidden:
            LOGGER.warning("Missing permission to update bug thread %s", thread.id)
        except discord.HTTPException:
            LOGGER.exception("Failed to update bug thread %s", thread.id)

    async def _reopen_bug_thread(self, message: discord.Message) -> None:
        thread = message.channel
        if not isinstance(thread, discord.Thread):
            return

        reopened_name = remove_bug_thread_status_prefix(thread.name)
        if reopened_name == thread.name:
            return

        try:
            await thread.edit(
                name=reopened_name,
                archived=False,
                reason=f"Reopened by {message.author}",
            )
            await thread.send("Reopened.")
            LOGGER.info("Reopened bug thread %s after message from %s", thread.id, message.author)
        except discord.Forbidden:
            LOGGER.warning("Missing permission to reopen bug thread %s", thread.id)
        except discord.HTTPException:
            LOGGER.exception("Failed to reopen bug thread %s", thread.id)

    async def _archive_bug_thread(self, thread: discord.Thread, reason_action: str) -> None:
        try:
            await thread.edit(archived=True, reason=reason_action)
        except discord.Forbidden:
            LOGGER.warning("Missing permission to archive bug thread %s", thread.id)
        except discord.HTTPException:
            LOGGER.exception("Failed to archive bug thread %s", thread.id)


def has_bug_thread_status_prefix(thread_name: str) -> bool:
    return BUG_THREAD_STATUS_PREFIX_RE.match(thread_name) is not None


def remove_bug_thread_status_prefix(thread_name: str) -> str:
    return BUG_THREAD_STATUS_PREFIX_RE.sub("", thread_name, count=1).strip() or thread_name


def should_mark_bug_thread_fixed(message: discord.Message, settings: Settings) -> bool:
    return should_handle_bug_thread_keyword(message, settings, "fixed")


def should_mark_bug_thread_not_a_bug(message: discord.Message, settings: Settings) -> bool:
    return should_handle_bug_thread_keyword(message, settings, "not a bug")


def should_reopen_bug_thread(message: discord.Message, settings: Settings) -> bool:
    return should_handle_bug_thread_keyword(message, settings, "reopen")


def should_handle_bug_thread_keyword(message: discord.Message, settings: Settings, keyword: str) -> bool:
    if message.author.bot:
        return False
    if not settings.fixed_author_user_ids:
        return False
    if message.author.id not in settings.fixed_author_user_ids:
        return False
    if message.content.strip().lower() != keyword:
        return False
    if not isinstance(message.channel, discord.Thread):
        return False
    if settings.bug_report_parent_channel_id is None:
        return False
    if message.channel.parent_id != settings.bug_report_parent_channel_id:
        return False
    return True


async def fetch_bug_report_parent(bot: LeftHandBot) -> discord.abc.GuildChannel | None:
    parent_id = bot.settings.bug_report_parent_channel_id
    if parent_id is None:
        return None

    channel = bot.get_channel(parent_id)
    if channel is None:
        try:
            channel = await bot.fetch_channel(parent_id)
        except discord.HTTPException:
            LOGGER.exception("Failed to fetch bug report parent channel %s", parent_id)
            return None

    if not isinstance(channel, discord.abc.GuildChannel):
        return None
    return channel


async def iter_archived_threads(
    parent: discord.abc.GuildChannel,
    limit: int,
) -> AsyncIterator[discord.Thread]:
    archived_threads = getattr(parent, "archived_threads", None)
    if not callable(archived_threads):
        return

    try:
        iterator = archived_threads(limit=limit)
    except TypeError:
        iterator = archived_threads(private=False, limit=limit)

    async for thread in iterator:
        yield thread


async def collect_bug_report_threads(bot: LeftHandBot) -> list[discord.Thread]:
    parent = await fetch_bug_report_parent(bot)
    if parent is None:
        return []

    parent_id = bot.settings.bug_report_parent_channel_id
    limit = bot.settings.bug_report_thread_scan_limit
    threads_by_id: dict[int, discord.Thread] = {}

    guild = getattr(parent, "guild", None)
    if guild is not None:
        for thread in getattr(guild, "threads", []):
            if thread.parent_id == parent_id:
                threads_by_id[thread.id] = thread

    for thread in getattr(parent, "threads", []):
        if isinstance(thread, discord.Thread):
            threads_by_id[thread.id] = thread

    remaining = max(0, limit - len(threads_by_id))
    if remaining > 0:
        try:
            async for thread in iter_archived_threads(parent, remaining):
                if thread.parent_id == parent_id:
                    threads_by_id[thread.id] = thread
        except discord.Forbidden:
            LOGGER.warning("Missing permission to read archived bug report threads")
        except discord.HTTPException:
            LOGGER.exception("Failed to read archived bug report threads")

    threads = list(threads_by_id.values())
    threads.sort(key=lambda thread: thread.created_at or datetime.min.replace(tzinfo=timezone.utc))
    return threads[:limit]


def bug_thread_summary_counts(threads: list[discord.Thread]) -> dict[str, int]:
    counts = {"open": 0, "fixed": 0, "not_a_bug": 0}
    for thread in threads:
        counts[bug_thread_status(thread.name)] += 1
    return counts


def bug_thread_result_line(thread: discord.Thread) -> str:
    title = thread.name[:90]
    status = bug_thread_status(thread.name).replace("_", " ")
    return f"[{title}]({thread_jump_url(thread)}) - {status}"


def register_commands(bot: LeftHandBot) -> None:
    @bot.tree.command(name="ping", description="Check whether Left Hand is online.")
    async def ping(interaction: discord.Interaction) -> None:
        latency_ms = round(bot.latency * 1000)
        await interaction.response.send_message(f"Pong. Gateway latency: {latency_ms} ms.")

    @bot.tree.command(name="status", description="Show the current EvilQuest server status.")
    async def status(interaction: discord.Interaction) -> None:
        await send_online_count(bot, interaction)

    @bot.tree.command(name="online", description="Show how many players are online in EvilQuest.")
    async def online(interaction: discord.Interaction) -> None:
        await send_online_count(bot, interaction)

    @bot.tree.command(name="server", description="Show live EvilQuest API and server status.")
    async def server(interaction: discord.Interaction) -> None:
        await send_server_status(bot, interaction)

    @bot.tree.command(name="player", description="Show an EvilQuest player's hiscore stats.")
    @app_commands.describe(
        name="The exact EvilQuest username to look up.",
        detail="Show every skill, including level-1 skills with 0 XP.",
    )
    async def player(interaction: discord.Interaction, name: str, detail: bool = False) -> None:
        await send_player_stats(bot, interaction, name, detail)

    @bot.tree.command(name="hiscores", description="Show the EvilQuest top 10 hiscores.")
    @app_commands.describe(category="The hiscore category to show.")
    @app_commands.choices(category=HISCORE_CATEGORY_CHOICES)
    async def hiscores(
        interaction: discord.Interaction,
        category: app_commands.Choice[str] | None = None,
    ) -> None:
        await send_top_hiscores(bot, interaction, category.value if category else "overall")

    @bot.tree.command(name="top", description="Show the EvilQuest top 10 for a skill or category.")
    @app_commands.describe(skill="The skill or hiscore category to show.")
    @app_commands.choices(skill=HISCORE_CATEGORY_CHOICES)
    async def top(
        interaction: discord.Interaction,
        skill: app_commands.Choice[str] | None = None,
    ) -> None:
        await send_top_hiscores(bot, interaction, skill.value if skill else "overall")

    @bot.tree.command(name="rank", description="Show an EvilQuest player's key hiscore ranks.")
    @app_commands.describe(name="The exact EvilQuest username to look up.")
    async def rank(interaction: discord.Interaction, name: str) -> None:
        await send_player_ranks(bot, interaction, name)

    @bot.tree.command(name="bugstats", description="Show bug-report thread counts.")
    async def bugstats(interaction: discord.Interaction) -> None:
        await send_bug_report_stats(bot, interaction)

    @bot.tree.command(name="bugsearch", description="Search bug-report thread titles.")
    @app_commands.describe(query="Text to search for in bug-report thread titles.")
    async def bugsearch(interaction: discord.Interaction, query: str) -> None:
        await send_bug_report_search(bot, interaction, query)

    @bot.tree.command(name="about", description="Show what Left Hand is.")
    async def about(interaction: discord.Interaction) -> None:
        await interaction.response.send_message("I am the Left Hand of anders")


async def send_online_count(bot: LeftHandBot, interaction: discord.Interaction) -> None:
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

    await interaction.followup.send(build_online_message(online_players))


async def send_server_status(bot: LeftHandBot, interaction: discord.Interaction) -> None:
    await interaction.response.defer(thinking=True)
    checked_at = int(datetime.now(timezone.utc).timestamp())
    api_status = "Unavailable"
    hiscores_status = "Unavailable"
    online_text = "Unknown"

    try:
        status_data = await bot.fetch_evilquest_status()
        online_players = status_data.get("onlinePlayers")
        if isinstance(online_players, int):
            api_status = "Online"
            online_text = str(online_players)
        else:
            api_status = "Unexpected response"
    except Exception:
        LOGGER.exception("Failed to fetch EvilQuest server status")

    try:
        hiscores_data = await bot.fetch_evilquest_json(
            "/api/hiscores",
            {"category": "overall", "limit": "1", "page": "1"},
        )
        if isinstance(hiscores_data.get("rows"), list):
            hiscores_status = "Online"
    except Exception:
        LOGGER.exception("Failed to fetch EvilQuest hiscores status")

    embed = discord.Embed(title="EvilQuest Server", color=discord.Color.dark_gold())
    embed.add_field(name="API", value=api_status, inline=True)
    embed.add_field(name="Hiscores", value=hiscores_status, inline=True)
    embed.add_field(name="Players Online", value=online_text, inline=True)
    embed.add_field(name="Checked", value=f"<t:{checked_at}:T>", inline=False)
    await interaction.followup.send(embed=embed)


async def fetch_player_profile(bot: LeftHandBot, name: str) -> tuple[str, list[dict[str, Any]]] | None:
    data = await bot.fetch_evilquest_json("/api/hiscores/player", {"username": name})
    username = str(data.get("username") or name)
    rows = [row for row in data.get("rows", []) if isinstance(row, dict)]
    if not rows:
        return None
    return username, rows


async def send_player_stats(
    bot: LeftHandBot,
    interaction: discord.Interaction,
    name: str,
    detail: bool,
) -> None:
    await interaction.response.defer(thinking=True)
    try:
        profile = await fetch_player_profile(bot, name)
    except aiohttp.ClientResponseError as exc:
        if exc.status == 404:
            await interaction.followup.send(f'No hiscore profile found for "{name}".')
            return
        LOGGER.exception("Failed to fetch EvilQuest player profile")
        await interaction.followup.send("EvilQuest player stats are unavailable right now.")
        return
    except Exception:
        LOGGER.exception("Failed to fetch EvilQuest player profile")
        await interaction.followup.send("EvilQuest player stats are unavailable right now.")
        return

    if profile is None:
        await interaction.followup.send(f'No hiscore profile found for "{name}".')
        return

    username, rows = profile
    await interaction.followup.send(embed=build_player_embed(username, rows, detail))


async def send_player_ranks(bot: LeftHandBot, interaction: discord.Interaction, name: str) -> None:
    await interaction.response.defer(thinking=True)
    try:
        profile = await fetch_player_profile(bot, name)
    except aiohttp.ClientResponseError as exc:
        if exc.status == 404:
            await interaction.followup.send(f'No hiscore profile found for "{name}".')
            return
        LOGGER.exception("Failed to fetch EvilQuest player ranks")
        await interaction.followup.send("EvilQuest ranks are unavailable right now.")
        return
    except Exception:
        LOGGER.exception("Failed to fetch EvilQuest player ranks")
        await interaction.followup.send("EvilQuest ranks are unavailable right now.")
        return

    if profile is None:
        await interaction.followup.send(f'No hiscore profile found for "{name}".')
        return

    username, rows = profile
    await interaction.followup.send(embed=build_rank_embed(username, rows))


async def send_top_hiscores(bot: LeftHandBot, interaction: discord.Interaction, category: str) -> None:
    await interaction.response.defer(thinking=True)
    try:
        data = await bot.fetch_evilquest_json(
            "/api/hiscores",
            {"category": category, "limit": "10", "page": "1"},
        )
    except Exception:
        LOGGER.exception("Failed to fetch EvilQuest hiscores")
        await interaction.followup.send("EvilQuest hiscores are unavailable right now.")
        return

    rows = [row for row in data.get("rows", []) if isinstance(row, dict)]
    category_data = data.get("category")
    title = f"Top 10 {category_name(category_data)} Hiscores"
    if not rows:
        await interaction.followup.send(f"{title}: no ranked players yet.")
        return

    lines = [hiscore_row_line(row) for row in rows]
    embed = discord.Embed(
        title=title,
        description="\n".join(lines),
        color=discord.Color.dark_gold(),
    )
    total_rows = as_int(data.get("totalRows"))
    if total_rows > 0:
        embed.set_footer(text=f"{total_rows:,} ranked players")
    await interaction.followup.send(embed=embed)


async def send_bug_report_stats(bot: LeftHandBot, interaction: discord.Interaction) -> None:
    await interaction.response.defer(thinking=True)
    threads = await collect_bug_report_threads(bot)
    if not threads:
        await interaction.followup.send("No bug-report threads were found.")
        return

    counts = bug_thread_summary_counts(threads)
    active_open_threads = [
        thread
        for thread in threads
        if bug_thread_status(thread.name) == "open" and not thread.archived
    ]
    all_open_threads = [thread for thread in threads if bug_thread_status(thread.name) == "open"]
    oldest_open = (active_open_threads or all_open_threads or [None])[0]

    embed = discord.Embed(title="Bug Report Threads", color=discord.Color.dark_gold())
    embed.add_field(name="Open", value=str(counts["open"]), inline=True)
    embed.add_field(name="Fixed", value=str(counts["fixed"]), inline=True)
    embed.add_field(name="Not A Bug", value=str(counts["not_a_bug"]), inline=True)
    embed.add_field(name="Scanned", value=str(len(threads)), inline=True)

    if oldest_open is not None:
        created_at = int(oldest_open.created_at.timestamp())
        embed.add_field(
            name="Oldest Open",
            value=f"[{oldest_open.name}]({thread_jump_url(oldest_open)})\nCreated <t:{created_at}:R>",
            inline=False,
        )
    else:
        embed.add_field(name="Oldest Open", value="None", inline=False)

    embed.set_footer(text=f"Includes active and up to {bot.settings.bug_report_thread_scan_limit} recent archived threads.")
    await interaction.followup.send(embed=embed)


async def send_bug_report_search(bot: LeftHandBot, interaction: discord.Interaction, query: str) -> None:
    await interaction.response.defer(thinking=True)
    normalized_query = query.strip().lower()
    if not normalized_query:
        await interaction.followup.send("Enter text to search for.")
        return

    threads = await collect_bug_report_threads(bot)
    matches = [
        thread
        for thread in threads
        if normalized_query in remove_bug_thread_status_prefix(thread.name).lower()
        or normalized_query in thread.name.lower()
    ]

    if not matches:
        await interaction.followup.send(f'No bug-report threads found matching "{query}".')
        return

    matches.sort(key=lambda thread: thread.created_at or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    lines = [bug_thread_result_line(thread) for thread in matches[:BUG_SEARCH_MAX_RESULTS]]
    embed = discord.Embed(
        title=f'Bug Search: "{query}"',
        description="\n".join(lines),
        color=discord.Color.dark_gold(),
    )
    if len(matches) > BUG_SEARCH_MAX_RESULTS:
        embed.set_footer(text=f"Showing {BUG_SEARCH_MAX_RESULTS} of {len(matches)} matches.")
    else:
        embed.set_footer(text=f"{len(matches)} match(es).")
    await interaction.followup.send(embed=embed)


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
