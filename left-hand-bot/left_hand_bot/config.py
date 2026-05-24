from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str) -> int | None:
    value = os.getenv(name)
    if not value:
        return None
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc


def _env_positive_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if not value:
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    return max(1, parsed)


def _env_int_set(name: str) -> frozenset[int]:
    raw = os.getenv(name, "")
    values: set[int] = set()
    for part in raw.split(","):
        value = part.strip()
        if not value:
            continue
        try:
            values.add(int(value))
        except ValueError as exc:
            raise ValueError(f"{name} must contain comma-separated integers") from exc
    return frozenset(values)


@dataclass(frozen=True)
class Settings:
    discord_token: str
    discord_guild_id: int | None
    evilquest_api_base_url: str
    evilquest_status_url: str
    bug_report_automation_enabled: bool
    bug_report_parent_channel_id: int | None
    fixed_author_user_ids: frozenset[int]
    bug_report_archive_on_status: bool
    bug_report_thread_scan_limit: int
    trading_post_channel_id: int | None
    items_path: str
    trade_listing_scan_limit: int
    log_level: str
    sync_commands: bool
    set_nickname: bool
    nickname: str


def load_settings() -> Settings:
    load_dotenv()

    token = os.getenv("DISCORD_TOKEN") or os.getenv("LEFT_HAND_DISCORD_TOKEN")
    if not token:
        raise RuntimeError("Set DISCORD_TOKEN or LEFT_HAND_DISCORD_TOKEN before starting Left Hand.")

    api_base_url = os.getenv("EVILQUEST_API_BASE_URL", "http://127.0.0.1:4000").rstrip("/")
    return Settings(
        discord_token=token,
        discord_guild_id=_env_int("DISCORD_GUILD_ID") or _env_int("LEFT_HAND_DISCORD_GUILD_ID"),
        evilquest_api_base_url=api_base_url,
        evilquest_status_url=os.getenv("EVILQUEST_STATUS_URL", f"{api_base_url}/api/status"),
        bug_report_automation_enabled=_env_bool("LEFT_HAND_BUG_REPORT_AUTOMATION_ENABLED", False),
        bug_report_parent_channel_id=_env_int("LEFT_HAND_BUG_REPORT_PARENT_CHANNEL_ID"),
        fixed_author_user_ids=_env_int_set("LEFT_HAND_FIXED_AUTHOR_USER_IDS"),
        bug_report_archive_on_status=_env_bool("LEFT_HAND_BUG_REPORT_ARCHIVE_ON_STATUS", True),
        bug_report_thread_scan_limit=_env_positive_int("LEFT_HAND_BUG_REPORT_THREAD_SCAN_LIMIT", 200),
        trading_post_channel_id=_env_int("LEFT_HAND_TRADING_POST_CHANNEL_ID"),
        items_path=os.getenv("LEFT_HAND_ITEMS_PATH", "/app/game-data/items.json"),
        trade_listing_scan_limit=_env_positive_int("LEFT_HAND_TRADE_LISTING_SCAN_LIMIT", 100),
        log_level=os.getenv("LOG_LEVEL", os.getenv("LEFT_HAND_LOG_LEVEL", "INFO")).upper(),
        sync_commands=_env_bool("SYNC_COMMANDS", True),
        set_nickname=_env_bool("LEFT_HAND_SET_NICKNAME", False),
        nickname=os.getenv("LEFT_HAND_NICKNAME", "Left Hand"),
    )
