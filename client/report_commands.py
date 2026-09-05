"""
report_commands.py
~~~~~~~~~~~~~~~~~~
`/report` — a player files a GitHub issue without a GitHub account.

The club's players are in Discord and the tracker is on GitHub, and asking
somebody to make an account to say "puzzle 46 is unsolvable" loses the report.
So the bot files it for them, under its own credential, with their name on it.

That last part is the whole of the security story: **this takes text typed by
anybody in the server and publishes it, under the bot's identity, to a public
repository.** Everything careful in here follows from that one sentence — the
defanging, the caps, the per-player limit, and the fact that a player is told
their name will be public before it is.

The reply is public too. A filed report is club business — somebody else hitting
the same bug should be able to see it is already known — so the confirmation and
its link go to the channel. Refusals do not: a rate limit read out in front of
everybody is a scolding, and it is nobody else's business.

Not a subcommand of `/puzzle`. Discord will not let a command be both invocable
and a group, and `/puzzle` is the one people type to announce the day; making it
a group to fit this in would rename the command everybody already knows for the
sake of a word.

Environment (see example.env):
    GITHUB_TOKEN    A fine-grained token with Issues: read and write on the one
                       repository below, and nothing else. Unset and the command
                       explains what is missing rather than failing shut.
    GITHUB_REPO     "owner/name" of the repository issues are filed against.
"""

import asyncio
import logging
import os

import aiohttp
import discord
from discord import app_commands

from report_text import (
    MAX_DESCRIPTION,
    REPORTS_PER_WINDOW,
    ReportLimiter,
    issue_body,
    issue_title,
)

log = logging.getLogger(__name__)

HTTP_TIMEOUT = aiohttp.ClientTimeout(total=10)
GITHUB_API = "https://api.github.com"

CATEGORIES = [
    app_commands.Choice(name="Bugged puzzle", value="Bugged puzzle"),
    app_commands.Choice(name="Wrong score or target", value="Wrong score or target"),
    app_commands.Choice(name="UI issue", value="UI issue"),
    app_commands.Choice(name="Discord bot", value="Discord bot"),
    app_commands.Choice(name="Suggestion", value="Suggestion"),
    app_commands.Choice(name="Something else", value="Something else"),
]


def _config() -> "tuple[str, str]":
    """The token and the repository, or two empty strings."""
    return os.getenv("GITHUB_TOKEN", "").strip(), os.getenv("GITHUB_REPO", "").strip()


limiter = ReportLimiter()

# A second bucket, above the individual. Three an hour each is right for a
# person and no bound at all on a raided server: a hundred accounts is three
# hundred issues an hour, filed under the bot's identity, which is enough for
# GitHub to act on the token and leaves an officer deleting them by hand. Keyed
# on the guild, and on `None` in a DM — where every DM shares one bucket, which
# is correct, since a DM report carries no server to answer for it.
#
# Deliberately not a global one: one raided server should not stop the others
# reporting.
GUILD_REPORTS_PER_WINDOW = 20
guild_limiter = ReportLimiter(limit=GUILD_REPORTS_PER_WINDOW)


class GitHubUnavailable(Exception):
    """The issue could not be filed. Carries a message meant for the player."""


async def open_issue(title: str, body: str) -> str:
    """Files the issue and answers with its URL."""
    token, repo = _config()
    if not token or not repo:
        raise GitHubUnavailable(
            "Reports aren't wired up yet — `GITHUB_TOKEN` or `GITHUB_REPO` is unset. "
            "Tell an officer; the two-minute fix is in example.env."
        )
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "BaronChairStair-bot",
    }
    try:
        async with aiohttp.ClientSession(timeout=HTTP_TIMEOUT) as session:
            async with session.post(
                f"{GITHUB_API}/repos/{repo}/issues",
                headers=headers,
                json={"title": title, "body": body},
            ) as response:
                if response.status != 201:
                    # The status is logged and never shown. A 401 or a 403 names
                    # the club's own misconfiguration, and a player can do
                    # nothing with it but read a credential problem out loud.
                    log.warning("github issue -> HTTP %s", response.status)
                    raise GitHubUnavailable(
                        "GitHub wouldn't take that just now. Try again in a minute, "
                        "and tell an officer if it keeps happening."
                    )
                created = await response.json(content_type=None)
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        log.warning("github issue failed: %s", exc)
        raise GitHubUnavailable("Couldn't reach GitHub. Try again in a minute.") from exc

    url = created.get("html_url") if isinstance(created, dict) else None
    if not isinstance(url, str):
        log.warning("github issue created without an html_url: %r", created)
        raise GitHubUnavailable("The issue was filed, but GitHub did not say where.")
    return url


@app_commands.command(
    name="report",
    description="Report a bug or suggest something. No GitHub account needed.",
)
@app_commands.describe(
    category="What kind of issue this is.",
    description=(
        "What happened, and what you expected instead. "
        "Posted publicly under your display name."
    ),
)
@app_commands.choices(category=CATEGORIES)
async def report_command(
    interaction: discord.Interaction,
    category: app_commands.Choice[str],
    description: str,
) -> None:
    # Two audiences, so two kinds of reply.
    #
    # The filed report is public: the channel gets the link, so somebody else
    # hitting the same bug can see it is already known, and an officer can pick
    # it up without being told. A refusal is not — "you have filed three reports
    # in the last hour" read out in front of the channel is a scolding, and the
    # length and rate checks are between the player and the bot.
    #
    # Which means the refusals must answer BEFORE any defer. Deferring
    # ephemerally would make every later followup ephemeral including the one
    # that should not be, and deferring publicly would post a visible "thinking"
    # for a report that is about to be turned away. These checks are all local
    # and instant, so they can answer directly; the deferral waits until there
    # is a GitHub call to wait on.
    text = description.strip()
    # No minimum length. A short report is still a report — "puzzle 46 is
    # unsolvable" is eight characters of useful signal, and turning somebody
    # away for brevity loses the thing the command exists to collect.
    #
    # Empty is still refused, because it is not a short report but the absence
    # of one: `issue_body("")` files an issue whose whole body is the footer.
    if not text:
        await interaction.response.send_message(
            "There was nothing in that report — say what happened and send it again.",
            ephemeral=True,
        )
        return
    if len(text) > MAX_DESCRIPTION:
        await interaction.response.send_message(
            f"That's longer than an issue can carry ({len(text)} characters against a "
            f"{MAX_DESCRIPTION} limit). Trim it, or add the long part as a reply on the "
            "issue afterwards.",
            ephemeral=True,
        )
        return

    if not limiter.take(interaction.user.id):
        minutes = max(1, limiter.opens_in(interaction.user.id) // 60)
        await interaction.response.send_message(
            f"You've filed {REPORTS_PER_WINDOW} reports in the last hour, which is plenty. "
            f"Try again in about {minutes} minute{'s' if minutes != 1 else ''}, or add to "
            "one of the issues you already opened.",
            ephemeral=True,
        )
        return

    # `or 0` so every DM shares one bucket. The alternative is `None` as a key,
    # which works but quietly widens what the limiter says it takes.
    room = interaction.guild_id or 0
    if not guild_limiter.take(room):
        limiter.refund(interaction.user.id)
        await interaction.response.send_message(
            "This server has filed a lot of reports in the last hour, so the bot is "
            "pausing for a bit. Nothing you did — tell an officer if it seems wrong.",
            ephemeral=True,
        )
        return

    # Public from here. Everything below either files an issue or explains why
    # the club's own setup stopped it, and both are worth the channel seeing.
    await interaction.response.defer(thinking=True)

    reporter = interaction.user.display_name
    try:
        url = await open_issue(
            issue_title(reporter, category.value),
            issue_body(
                text,
                reporter=reporter,
                guild=interaction.guild.name if interaction.guild else None,
            ),
        )
    except GitHubUnavailable as exc:
        # Nothing was filed, so nothing is spent. Both buckets, in the order
        # they were taken: a club that has not set `GITHUB_TOKEN` yet would
        # otherwise let one player burn their hour on the error message.
        limiter.refund(interaction.user.id)
        guild_limiter.refund(room)
        await interaction.followup.send(str(exc))
        return

    await interaction.followup.send(
        f"Filed as **{category.value}** — {url}\n"
        f"Reported by {interaction.user.mention}, on a public tracker under their "
        "Discord display name. Reply on the issue to add to it."
    )
