#!/usr/bin/env python3
"""The Hermes SOUL.md size cap: read it, judge a file against it. Shared by health-check.py (the
standing alarm) and sync-architect-facts.py (the pre-write guard) so the two can never disagree.

WHY THIS EXISTS (2026-09-25)
Hermes loads SOUL.md in full only while it is under `context_file_max_chars`. One byte over and
`prompt_builder.py` keeps the first 70% and the last 20% OF THE CAP and drops the middle, so a
37,832-char file against a 31,457 cap loses 9,521 chars, all of it from the ARCHITECT: OPERATING
FACTS block (measured on Drevan's file). That much was known on 09-24. What was not known:

  * With the key set to `null` (all three profiles until today), the cap is NOT a number. It is
    `model window x 4 x 0.06`, and the window comes from `get_model_context_length`, which probes
    the provider's /models endpoint at gateway start. Probe succeeds: 262,144 -> cap 62,914, nothing
    truncated. Probe fails (network blip, provider hiccup, key rejected): the static
    `DEFAULT_CONTEXT_LENGTHS["qwen"] = 131072` applies -> cap 31,457 -> Drevan and Gaia cut.
  * Nothing records which one a boot got. The truncation warning goes to the agent status channel
    (`system_prompt.py:490`), not to gateway.log or agent.log; state.db does not persist system
    prompts. Two sessions on 09-24/25 argued from different numbers and both were right, on
    different boots.

That is decision 1 of "own the harness" (what is in the window) with no author at all. Claude Code
never sizes its identity file by a network call. So: PIN the cap in each profile's config.yaml
(Hermes's own "user knows best" override, resolution step 1 in `_get_context_file_max_chars`), and
treat an unpinned cap as RED here, so the probe can never quietly come back.

The margin exists because the cut is a cliff, not a slope: the check has to speak before the file
touches the line, not after.
"""
import os

# Below this much headroom the health check WARNs and the sync refuses. 3,000 chars is about a
# week of facts arriving at the 09-22 rate, which is the reaction time the check is buying.
DEFAULT_MARGIN = 3000

# What the three profiles are pinned to (2026-09-25). Kept here as documentation and as the value
# a future profile should copy; the live number is ALWAYS read from the profile's config.yaml.
# Chosen so the smallest model on the lever (Kimi 128k) still loads the whole file: 60,000 chars is
# ~15k tokens, 11% of a 131k window, and gives Drevan (37.8k today) 22k of headroom.
PINNED_CAP_RECOMMENDED = 60000


def read_pinned_cap(config_path):
    """The explicit `context_file_max_chars` in a Hermes config.yaml, or None when it is absent,
    `null`, unreadable, or <= 0 (Hermes ignores those and falls back to the probe).

    No YAML dependency on purpose: the ops scripts run on the system python3 with no packages,
    and the key is a single top-level `key: value` line.
    """
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            for line in f:
                if not line.startswith("context_file_max_chars:"):
                    continue
                raw = line.split(":", 1)[1].strip()
                try:
                    n = int(raw)
                except ValueError:
                    return None
                return n if n > 0 else None
    except OSError:
        return None
    return None


def _n(x):
    return "{:,}".format(x)


def assess(size, cap, margin=DEFAULT_MARGIN):
    """Judge a SOUL.md of `size` chars against `cap`. Returns (severity, detail) in the health
    check's vocabulary: ok / warning / red.

      cap is None      -> red. Unpinned means the cap is whatever this boot's probe returned.
      size >= cap      -> red. Hermes is cutting the middle out of the identity file right now.
      size > cap-margin -> warning. Still whole, but one facts sync from the cliff.
      otherwise        -> ok, with the numbers, so a reader can see the trend before it is a fault.
    """
    if cap is None:
        return ("red",
                "context_file_max_chars is not pinned, so the cap is a boot-time probe of the "
                "provider (262k window -> 62,914 cap when it succeeds, 131k -> 31,457 when it "
                "fails) and nothing records which one this boot got; pin it (file is %s chars)"
                % _n(size))
    if size >= cap:
        kept = int(cap * 0.7) + int(cap * 0.2)
        cut = size - kept
        return ("red",
                "%s chars against a %s cap: Hermes keeps %s (70%%+20%% of the cap) and cuts %s "
                "out of the middle on every prompt build"
                % (_n(size), _n(cap), _n(kept), _n(cut)))
    headroom = cap - size
    if headroom < margin:
        return ("warning",
                "%s chars against a %s cap: %s headroom, under the %s margin; the next facts sync "
                "can put this over the cliff" % (_n(size), _n(cap), _n(headroom), _n(margin)))
    return ("ok", "%s chars against a %s cap, %s headroom" % (_n(size), _n(cap), _n(headroom)))
