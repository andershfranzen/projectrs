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


@dataclass(frozen=True)
class Settings:
    discord_token: str
    discord_guild_id: int | None
    evilquest_status_url: str
    log_level: str
    sync_commands: bool
    set_nickname: bool
    nickname: str


def load_settings() -> Settings:
    load_dotenv()

    token = os.getenv("DISCORD_TOKEN") or os.getenv("LEFT_HAND_DISCORD_TOKEN")
    if not token:
        raise RuntimeError("Set DISCORD_TOKEN or LEFT_HAND_DISCORD_TOKEN before starting Left Hand.")

    return Settings(
        discord_token=token,
        discord_guild_id=_env_int("DISCORD_GUILD_ID") or _env_int("LEFT_HAND_DISCORD_GUILD_ID"),
        evilquest_status_url=os.getenv("EVILQUEST_STATUS_URL", "http://127.0.0.1:4000/api/status"),
        log_level=os.getenv("LOG_LEVEL", os.getenv("LEFT_HAND_LOG_LEVEL", "INFO")).upper(),
        sync_commands=_env_bool("SYNC_COMMANDS", True),
        set_nickname=_env_bool("LEFT_HAND_SET_NICKNAME", False),
        nickname=os.getenv("LEFT_HAND_NICKNAME", "Left Hand"),
    )

