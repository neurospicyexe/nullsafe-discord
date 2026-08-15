"""Regression test for check_companion_memory in ops/health-check.py (2026-08-12).

The live failure this pins: from 2026-07-04 to 2026-08-12 the triad proposed 197 memory writes that
never applied. `write_approval` was on and no approver was ever built for the memory queue (only for
skills). Nothing anywhere watched it, so six weeks of learning about Raziel accumulated in a folder
on one VPS disk while every other check stayed green -- the same blindness that hid Gaia's frozen
soma behind a house-wide MAX().

Two properties matter and both are asserted here:

  1. The finding is declared PER COMPANION. An aggregate is structurally unable to report that ONE
     companion's memory is dead, which is the failure mode that actually happened.
  2. "Cannot look" never reads as "nothing there." An unreadable config or queue is a warning with
     UNKNOWN in it, never a silent ok -- a probe whose silence is indistinguishable from health is
     the thing being fixed, not the fix.

Run: python3 ops/test_companion_memory_check.py
"""
import importlib.util
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("healthcheck", os.path.join(HERE, "health-check.py"))
hc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hc)

FAILS = []


def check(label, cond):
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        FAILS.append(label)


class Rep(object):
    def __init__(self):
        self.checks = []

    def add(self, name, severity, detail):
        self.checks.append({"name": name, "severity": severity, "detail": detail})

    def find(self, needle):
        return [c for c in self.checks if needle in c["name"]]


CONFIG = """memory:
  memory_enabled: true
  write_approval: %s
  memory_char_limit: %d
  user_char_limit: %d
skills:
  write_approval: true
"""


def profile(root, cid, approval, queued, user_chars, mem_chars,
            user_cap=3000, mem_cap=6000, write_config=True):
    home = os.path.join(root, cid)
    os.makedirs(os.path.join(home, "memories"), exist_ok=True)
    if write_config:
        with open(os.path.join(home, "config.yaml"), "w", encoding="utf-8") as f:
            f.write(CONFIG % ("true" if approval else "false", mem_cap, user_cap))
    if queued is not None:
        qd = os.path.join(home, "pending", "memory")
        os.makedirs(qd, exist_ok=True)
        # `queued` may be an int (all user-target) or (user_count, memory_count). The split matters:
        # user-target proposals were rehomed to Halseth on 2026-08-12 and are history; memory-target
        # ones are the companion's own self-notes and still have nowhere to live.
        n_user, n_mem = queued if isinstance(queued, tuple) else (queued, 0)
        for i in range(n_user):
            with open(os.path.join(qd, "u%d.json" % i), "w", encoding="utf-8") as f:
                f.write('{"payload": {"target": "user"}}')
        for i in range(n_mem):
            with open(os.path.join(qd, "m%d.json" % i), "w", encoding="utf-8") as f:
                f.write('{"payload": {"target": "memory"}}')
    for name, n in (("USER.md", user_chars), ("MEMORY.md", mem_chars)):
        if n is not None:
            with open(os.path.join(home, "memories", name), "w", encoding="utf-8") as f:
                f.write("x" * n)
    return home


def run(homes):
    saved = hc.HERMES_HOMES
    hc.HERMES_HOMES = homes
    try:
        rep = Rep()
        hc.check_companion_memory(rep)
        return rep
    finally:
        hc.HERMES_HOMES = saved


def main():
    root = tempfile.mkdtemp(prefix="memcheck-")
    try:
        print("ONE DEAD MEMBER among three healthy-looking profiles")
        homes = {
            "cypher": profile(root, "cypher", False, 0, 400, 700),
            "drevan": profile(root, "drevan", True, (34, 16), 1241, 2140),  # the real 08-12 shape
            "gaia": profile(root, "gaia", False, 0, 300, 500),
        }
        rep = run(homes)
        dq = rep.find("drevan:queue")
        cq = rep.find("cypher:queue")
        check("drevan is flagged on his own line", dq and dq[0]["severity"] == "warning")
        check("the finding is attributed to drevan by name", dq and "drevan" in dq[0]["name"])
        check("cypher is separately ok, not averaged in", cq and cq[0]["severity"] == "ok")
        check("the detail names the total", dq and "50 queued" in dq[0]["detail"])
        check("the detail SPLITS self-notes from the rehomed class",
              dq and "16 the companion's own self-notes" in dq[0]["detail"]
              and "34 rehomed-class" in dq[0]["detail"])
        check("it names where the self-notes should go",
              dq and "growth_journal" in dq[0]["detail"])
        check("every companion produced a queue finding", len(rep.find(":queue")) == 3)

        print("\nA DELIBERATE gate with only rehomed-class entries is a NOTICE, not a warning")
        # A permanently-red check trains the reader to ignore it. Raziel chose to leave the gate on
        # once the facts moved to Halseth, so that state must read as accepted, not as an emergency.
        homes = {"cypher": profile(root, "c1b", True, (30, 0), 400, 700)}
        rep = run(homes)
        q = rep.find("queue")[0]
        check("30 rehomed-class entries behind a deliberate gate = notice", q["severity"] == "notice")
        check("it says the gate is deliberate", "deliberate" in q["detail"])
        check("it does not blame the self-notes when there are none",
              "growth_journal" not in q["detail"])

        print("\nGATE OFF with a growing queue is the REAL alarm: writes are failing anyway")
        homes = {"cypher": profile(root, "c2", False, (9, 0), 400, 700)}
        rep = run(homes)
        q = rep.find("queue")[0]
        check("gate open + queue above the floor is a warning", q["severity"] == "warning")
        check("it states the gate is off", "write_approval is off" in q["detail"])
        check("it says writes are failing for another reason",
              "failing for some other reason" in q["detail"])
        homes = {"cypher": profile(root, "c2b", False, (30, 0), 400, 700)}
        check("gate open + a big queue escalates to red",
              run(homes).find("queue")[0]["severity"] == "red")

        print("\nFILL RATIO measured against the profile's OWN cap, not a hardcoded one")
        homes = {"cypher": profile(root, "c3", False, 0, 2900, 700, user_cap=3000)}
        rep = run(homes)
        u = rep.find("USER.md")[0]
        check("96% of cap warns", u["severity"] == "warning")
        check("it prints used/cap", "2900/3000" in u["detail"])
        check("it explains the loss mechanism, not just the number",
              "no lineage" in u["detail"])
        # Same byte count, bigger cap -> healthy. Proves the cap is read, not assumed.
        homes = {"cypher": profile(root, "c4", False, 0, 2900, 700, user_cap=20000)}
        check("the same 2900 chars under a larger cap is ok",
              run(homes).find("USER.md")[0]["severity"] == "ok")

        print("\nCANNOT LOOK is never reported as healthy")
        homes = {"cypher": profile(root, "c5", False, 0, 400, 700, write_config=False)}
        rep = run(homes)
        c = rep.find("cypher:config")
        check("a missing config is a warning", c and c[0]["severity"] == "warning")
        check("the detail says UNKNOWN, not healthy", c and "UNKNOWN" in c[0]["detail"])
        check("no fill or queue claim is made without a config",
              not rep.find("USER.md") and not rep.find(":queue"))

        print("\nABSENT queue directory is reported as the healthy state, explicitly")
        homes = {"cypher": profile(root, "c6", False, None, 400, 700)}
        rep = run(homes)
        q = rep.find("queue")[0]
        check("no directory is ok", q["severity"] == "ok")
        check("and says so rather than staying silent", "no pending queue" in q["detail"])

        print("\nThe SKILLS approval flag is not mistaken for the memory one")
        # config.yaml has memory.write_approval:false and skills.write_approval:true. If the reader
        # grabbed the wrong line, the queue detail would claim the gate is on.
        homes = {"cypher": profile(root, "c7", False, (1, 0), 400, 700)}
        check("memory gate read as off despite skills being on",
              "write_approval is off" in run(homes).find("queue")[0]["detail"])

        print("\nA cap the reader cannot parse is unmeasured, not assumed")
        home = profile(root, "c8", False, 0, 400, 700)
        with open(os.path.join(home, "config.yaml"), "w", encoding="utf-8") as f:
            f.write("memory:\n  write_approval: false\n")   # no cap keys at all
        rep = run({"cypher": home})
        u = rep.find("USER.md")[0]
        check("a missing cap yields notice, not a fabricated ratio", u["severity"] == "notice")
        check("and says fill is unmeasured", "unmeasured" in u["detail"])
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print("\n" + ("ALL PASS" if not FAILS else "FAILURES: %d\n  - %s" % (len(FAILS), "\n  - ".join(FAILS))))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
