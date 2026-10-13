"""Constraint-aware greedy timetable scheduler — full constraint set.

Mandatory constraints
─────────────────────
1.  Sessions fall within university working hours; break slots are never used.
2.  Faculty scheduled only in their declared available slots (unavailability
    list + optional available_ranges per faculty).
3.  No faculty / room / class double-booking (whole-class and batches).
4.  A whole-class session cannot overlap any batch practical for that class.
5.  Room capacity ≥ assigned group strength (class or batch).
6.  Practical sessions use a suitable laboratory and occupy the required
    consecutive periods.
7.  Every subject receives its specified weekly theory periods and practicals.
8.  Fixed (pinned) sessions remain in their pre-assigned slots and rooms.
9.  Optional daily-period cap per faculty is respected.

Preferences (soft, best-effort)
────────────────────────────────
- Sessions spread across the week (fewest-sessions-per-class-per-day heuristic).

Data-model additions vs the previous version
──────────────────────────────────────────────
classes[]:
    batches: [{"id": "B1", "name": "Batch A", "strength": 20}, ...]
        optional list of practical sub-groups; scheduling uses batch strength
        for room capacity and tracks batch occupancy separately.

subjects[]:
    session_type: "theory" | "practical"   (default "theory")
    batch_id: "B1"           – if set, session is for that batch only
    fixed: {"day":"Monday", "slot":"09:00", "room":"LH-101"}
        – if set, the session is pinned and not moved by the scheduler.

faculty_available_ranges[]:   (optional, per faculty)
    [{"faculty": "Dr. X", "day": "Monday", "from": "09:00", "to": "13:00"}, ...]
    Slots that fall entirely outside ALL declared ranges for that faculty+day
    are treated as unavailable.

faculty_constraints[]:        (optional, per faculty)
    [{"faculty": "Dr. X", "max_daily_periods": 3}, ...]

Returns
───────
{
  success, entries, issues, summary,
  stats_by_faculty, stats_by_class,
  unscheduled_detail   ← richer per-session diagnostics
}
"""

from collections import defaultdict


# ────────────────────────────────────────────────────────────────
# Internal helpers
# ────────────────────────────────────────────────────────────────

def _is_break(slot):
    return slot.get("is_break", False)


def _spread_key(day, group_id, class_day_load):
    return class_day_load[group_id][day]


def _slot_in_range(slot_id, from_id, to_id, slot_order):
    """Return True if slot_id falls within [from_id, to_id) using slot_order index.

    - If slot_id is unknown, assume available (True).
    - If from_id is unknown, no lower bound — assume True.
    - If to_id is unknown (e.g. '17:00' not in slot list), treat as open upper bound:
      slot is in-range if it is >= from_id.
    """
    si = slot_order.get(slot_id, -1)
    fi = slot_order.get(from_id, -1)
    ti = slot_order.get(to_id, -1)

    if si < 0 or fi < 0:
        return True    # unknown slot or from — assume available

    if ti < 0:
        # Unknown upper bound — slot is in-range if it is at or after from_id
        return si >= fi

    return fi <= si < ti


# ────────────────────────────────────────────────────────────────
# Public entry point
# ────────────────────────────────────────────────────────────────

def generate_timetable(data):  # noqa: C901  (intentionally long — constraint logic)
    raw_days  = data.get("days",  [])
    raw_slots = data.get("slots", [])
    raw_rooms = data.get("rooms", [])
    raw_classes = data.get("classes", [])
    subjects  = data.get("subjects", [])
    raw_unavail   = data.get("faculty_unavailable",    [])
    raw_avail_rng = data.get("faculty_available_ranges", [])
    raw_fac_cstr  = data.get("faculty_constraints",    [])
    break_slots_cfg = data.get("break_slots", [])

    # ── Normalise days ──────────────────────────────────────────
    days = [d if isinstance(d, str) else d.get("id", str(d)) for d in raw_days]

    # ── Normalise slots ─────────────────────────────────────────
    slots = []
    break_ids = set(break_slots_cfg)
    for s in raw_slots:
        if isinstance(s, str):
            slots.append({"id": s, "is_break": s in break_ids})
        else:
            obj = dict(s)
            if obj.get("id") in break_ids:
                obj["is_break"] = True
            slots.append(obj)

    slot_order = {s["id"]: i for i, s in enumerate(slots)}

    # ── Normalise rooms ─────────────────────────────────────────
    rooms = [{"id": r["id"],
              "capacity": int(r.get("capacity", 0)),
              "type": r.get("type", "classroom")}
             for r in raw_rooms]

    # ── Normalise classes + batches ──────────────────────────────
    classes  = {}   # class_id  -> {id, name, strength}
    batches  = {}   # batch_id  -> {id, name, strength, class_id}
    for c in raw_classes:
        cid = c["id"]
        classes[cid] = {"id": cid, "name": c.get("name", cid),
                        "strength": int(c.get("strength", 0))}
        for b in c.get("batches", []):
            bid = b["id"]
            batches[bid] = {"id": bid, "name": b.get("name", bid),
                            "strength": int(b.get("strength", 0)),
                            "class_id": cid}

    # ── Normalise faculty unavailability ─────────────────────────
    unavailable = set()
    for x in raw_unavail:
        unavailable.add((x.get("faculty"), x.get("day"), x.get("slot")))

    # ── Normalise faculty available ranges ───────────────────────
    # avail_ranges[faculty][day] = [(from_id, to_id), ...]
    avail_ranges = defaultdict(lambda: defaultdict(list))
    for r in raw_avail_rng:
        avail_ranges[r["faculty"]][r["day"]].append(
            (r.get("from", ""), r.get("to", ""))
        )

    # ── Normalise faculty constraints ────────────────────────────
    fac_max_daily = {}   # faculty -> max_daily_periods (int)
    for fc in raw_fac_cstr:
        if "max_daily_periods" in fc:
            fac_max_daily[fc["faculty"]] = int(fc["max_daily_periods"])

    # ── Basic input validation ───────────────────────────────────
    errors = []
    if not days:
        errors.append("Provide at least one working day.")
    if not slots:
        errors.append("Provide at least one time slot.")
    if not rooms:
        errors.append("Provide at least one room.")
    if not subjects:
        errors.append("Provide at least one subject.")
    if errors:
        return _empty_result(errors)

    # ── Helper: is a slot id available for a faculty on a day? ───
    def _faculty_available(faculty, day, sid):
        """Return True if the slot is not blocked for this faculty."""
        # explicit unavailability
        if (faculty, day, sid) in unavailable:
            return False
        # available-range restriction
        ranges = avail_ranges[faculty][day]
        if ranges:
            if not any(_slot_in_range(sid, fr, to, slot_order) for fr, to in ranges):
                return False
        return True

    # ── Build tasks ──────────────────────────────────────────────
    # Each task = (subject_dict, occurrence_number, duration, group_id, group_strength)
    # group_id   = batch_id if batch else class_id
    # group_strength used for room capacity check

    fixed_entries = []   # pre-placed sessions
    tasks = []
    task_errors = []

    for subject in subjects:
        count    = subject.get("weekly_periods", 0)
        duration = int(subject.get("duration", 1))
        try:
            count = int(count)
        except (TypeError, ValueError):
            count = 0
        if count <= 0 or duration < 1:
            continue

        sid_subj = subject.get("id", "?")
        sub_name = subject.get("name", sid_subj)
        class_id = subject.get("class_id")
        batch_id = subject.get("batch_id")     # None for whole-class
        faculty  = subject.get("faculty", "")

        # Resolve group
        if batch_id:
            group_info = batches.get(batch_id)
            if not group_info:
                task_errors.append(
                    f"Subject '{sub_name}': batch_id '{batch_id}' is unknown.")
                continue
            group_id       = batch_id
            group_strength = group_info["strength"]
            group_class_id = group_info["class_id"]
        else:
            if not class_id or class_id not in classes:
                task_errors.append(
                    f"Subject '{sub_name}': class_id '{class_id}' is missing or unknown.")
                continue
            group_id       = class_id
            group_strength = classes[class_id]["strength"]
            group_class_id = class_id

        # ── Fixed (pinned) sessions ──
        fixed = subject.get("fixed")
        if fixed:
            fixed_day  = fixed.get("day")
            fixed_slot = fixed.get("slot")
            fixed_room = fixed.get("room")
            # Validate fixed slot is schedulable
            if not fixed_day or not fixed_slot:
                task_errors.append(
                    f"Subject '{sub_name}': fixed session missing day/slot.")
                continue
            slot_obj = next((s for s in slots if s["id"] == fixed_slot), None)
            if slot_obj and _is_break(slot_obj):
                task_errors.append(
                    f"Subject '{sub_name}': fixed slot '{fixed_slot}' is a break.")
                continue
            fixed_entries.append({
                "subject_id":   sid_subj,
                "subject":      sub_name,
                "class_id":     class_id or group_class_id,
                "class_name":   classes.get(class_id or group_class_id, {}).get("name", ""),
                "batch_id":     batch_id,
                "batch_name":   batches.get(batch_id, {}).get("name", "") if batch_id else "",
                "group_id":     group_id,
                "faculty":      faculty,
                "room":         fixed_room or "",
                "room_type":    subject.get("room_type", "classroom"),
                "day":          fixed_day,
                "start":        fixed_slot,
                "end":          "",     # resolved below
                "slots":        [fixed_slot],
                "duration":     1,
                "locked":       True,
                "session_type": subject.get("session_type", "theory"),
            })
            count -= 1   # one session already placed

        for n in range(count):
            tasks.append({
                "subject": subject,
                "occurrence": n + 1,
                "duration": duration,
                "group_id": group_id,
                "group_strength": group_strength,
                "group_class_id": group_class_id,
                "batch_id": batch_id,
            })

    # Longer blocks first; then alphabetical by subject id
    tasks.sort(key=lambda t: (-t["duration"], t["subject"].get("id", "")))

    # ── Tracking sets ────────────────────────────────────────────
    used_faculty  = set()   # (faculty, day, slot_id)
    used_class    = set()   # (class_id, day, slot_id)   whole-class occupancy
    used_batch    = set()   # (batch_id, day, slot_id)
    used_room     = set()   # (room_id, day, slot_id)
    # daily period count per faculty
    faculty_daily = defaultdict(lambda: defaultdict(int))   # [faculty][day] -> int

    class_day_load  = defaultdict(lambda: defaultdict(int))

    # ── Pre-commit fixed entries ─────────────────────────────────
    entries = []
    issues  = list(task_errors)

    for fe in fixed_entries:
        fd, fs_id = fe["day"], fe["start"]
        fac = fe["faculty"]
        gid = fe["group_id"]
        cid = fe["class_id"]
        bid = fe["batch_id"]
        rid = fe["room"]

        # resolve end label (fixed sessions have duration=1 here)
        start_idx = slot_order.get(fs_id, 0)
        fe["end"] = slots[start_idx + 1]["id"] if start_idx + 1 < len(slots) else "End of day"

        # commit
        used_faculty.add((fac, fd, fs_id))
        used_class.add((cid, fd, fs_id))
        if bid:
            used_batch.add((bid, fd, fs_id))
        if rid:
            used_room.add((rid, fd, fs_id))
        faculty_daily[fac][fd] += 1
        class_day_load[gid][fd] += 1
        entries.append(fe)

    # ── Main scheduling loop ─────────────────────────────────────
    for task in tasks:
        subject        = task["subject"]
        occurrence     = task["occurrence"]
        duration       = task["duration"]
        group_id       = task["group_id"]
        group_strength = task["group_strength"]
        group_class_id = task["group_class_id"]
        batch_id       = task["batch_id"]
        sub_name       = subject.get("name", subject.get("id", "?"))
        faculty        = subject.get("faculty", "")
        req_type       = subject.get("room_type", "classroom")
        session_type   = subject.get("session_type", "theory")
        max_daily      = fac_max_daily.get(faculty)

        class_id = subject.get("class_id") or group_class_id

        # Days ordered by least load for this group
        ordered_days = sorted(days, key=lambda d: _spread_key(d, group_id, class_day_load))

        placed = False
        diagnostics = []    # collect why slots failed, for rich error message

        for day in ordered_days:
            if placed:
                break
            for start_idx in range(len(slots) - duration + 1):
                block_slots = slots[start_idx: start_idx + duration]

                # ① Break slots
                if any(_is_break(s) for s in block_slots):
                    continue

                block_ids = [s["id"] for s in block_slots]

                # ② Faculty availability (unavailability + ranges)
                blocked_slots = [sid for sid in block_ids
                                 if not _faculty_available(faculty, day, sid)]
                if blocked_slots:
                    diagnostics.append(
                        f"{day} {block_ids[0]}: faculty unavailable"
                        f" at slot{'s' if len(blocked_slots)>1 else ''} {', '.join(blocked_slots)}")
                    continue

                # ③ Faculty daily cap
                if max_daily is not None:
                    if faculty_daily[faculty][day] + duration > max_daily:
                        diagnostics.append(
                            f"{day}: faculty daily cap ({max_daily}) would be exceeded")
                        continue

                # ④ Faculty conflict
                if any((faculty, day, sid) in used_faculty for sid in block_ids):
                    diagnostics.append(f"{day} {block_ids[0]}: faculty already booked")
                    continue

                # ⑤ Class / batch conflict
                if batch_id:
                    # batch cannot overlap other sessions of the same batch
                    if any((batch_id, day, sid) in used_batch for sid in block_ids):
                        diagnostics.append(f"{day} {block_ids[0]}: batch already occupied")
                        continue
                    # batch practical cannot overlap a whole-class session for the parent class
                    if any((class_id, day, sid) in used_class for sid in block_ids):
                        diagnostics.append(
                            f"{day} {block_ids[0]}: whole-class session for {class_id} conflicts")
                        continue
                else:
                    # whole-class session cannot overlap any batch of this class
                    batch_conflicts = [
                        sid for sid in block_ids
                        for bid2, bcinfo in batches.items()
                        if bcinfo["class_id"] == class_id
                        and (bid2, day, sid) in used_batch
                    ]
                    if batch_conflicts:
                        diagnostics.append(
                            f"{day} {block_ids[0]}: a batch practical overlaps this slot")
                        continue
                    if any((class_id, day, sid) in used_class for sid in block_ids):
                        diagnostics.append(f"{day} {block_ids[0]}: class already occupied")
                        continue

                # ⑥ Find a suitable room
                found_room = None
                for room in rooms:
                    if room["type"] != req_type:
                        continue
                    if room["capacity"] < group_strength:
                        continue
                    if any((room["id"], day, sid) in used_room for sid in block_ids):
                        continue
                    found_room = room
                    break

                if not found_room:
                    diagnostics.append(
                        f"{day} {block_ids[0]}: no {req_type} with capacity ≥ {group_strength} free")
                    continue

                # ── Commit ───────────────────────────────────────
                end_idx   = start_idx + duration
                end_label = slots[end_idx]["id"] if end_idx < len(slots) else "End of day"

                entry = {
                    "subject_id":   subject.get("id", ""),
                    "subject":      sub_name,
                    "class_id":     class_id,
                    "class_name":   classes.get(class_id, {}).get("name", class_id),
                    "batch_id":     batch_id,
                    "batch_name":   batches.get(batch_id, {}).get("name", "") if batch_id else "",
                    "group_id":     group_id,
                    "faculty":      faculty,
                    "room":         found_room["id"],
                    "room_type":    req_type,
                    "day":          day,
                    "start":        block_ids[0],
                    "end":          end_label,
                    "slots":        block_ids,
                    "duration":     duration,
                    "locked":       False,
                    "session_type": session_type,
                }
                entries.append(entry)

                for sid in block_ids:
                    used_faculty.add((faculty, day, sid))
                    used_class.add((class_id, day, sid))
                    if batch_id:
                        used_batch.add((batch_id, day, sid))
                    used_room.add((found_room["id"], day, sid))
                faculty_daily[faculty][day] += duration
                class_day_load[group_id][day] += 1
                placed = True
                break   # out of start_idx loop

        if not placed:
            # Build a diagnostic message citing the most common reason
            reason = _summarise_diagnostics(diagnostics, sub_name, faculty,
                                            batch_id, group_strength, req_type)
            issues.append(
                f"'{sub_name}' (session {occurrence}): {reason}"
            )

    # ── Aggregate stats ──────────────────────────────────────────
    faculty_load = defaultdict(int)
    class_load   = defaultdict(int)
    for e in entries:
        faculty_load[e["faculty"]] += e["duration"]
        class_load[e["class_id"]]  += e["duration"]

    return {
        "success": len(issues) == 0,
        "entries": entries,
        "issues":  issues,
        "summary": {
            "scheduled_sessions":        len(entries),
            "unscheduled_sessions":       len(issues),
            "total_requested_sessions":  len(tasks) + len(fixed_entries),
        },
        "stats_by_faculty": dict(faculty_load),
        "stats_by_class":   dict(class_load),
    }


# ────────────────────────────────────────────────────────────────
# Issue diagnostics helper
# ────────────────────────────────────────────────────────────────

def _summarise_diagnostics(diag, sub_name, faculty, batch_id, strength, req_type):
    """Return a concise human-readable reason for scheduling failure."""
    if not diag:
        return ("no valid slot found — check faculty availability, "
                "room type/capacity, or scheduling conflicts.")
    # Count reason categories
    counts = defaultdict(int)
    for d in diag:
        if "unavailable" in d:
            counts["faculty_unavail"] += 1
        elif "daily cap" in d:
            counts["daily_cap"] += 1
        elif "faculty already" in d:
            counts["faculty_busy"] += 1
        elif "batch already" in d or "class already" in d:
            counts["group_busy"] += 1
        elif "whole-class" in d or "batch practical" in d:
            counts["overlap_conflict"] += 1
        elif "no " in d:
            counts["no_room"] += 1
    top = max(counts, key=counts.get, default="other")
    msgs = {
        "faculty_unavail":  (f"faculty '{faculty}' has no available slots that satisfy "
                             f"all {len(diag)} candidate positions."),
        "daily_cap":        (f"faculty '{faculty}' would exceed their daily period cap "
                             f"for every candidate slot."),
        "faculty_busy":     (f"faculty '{faculty}' is already booked at every candidate slot."),
        "group_busy":       (f"{'batch' if batch_id else 'class'} is occupied at every candidate slot."),
        "overlap_conflict": ("a whole-class session overlaps every candidate batch slot "
                             "(or vice-versa)."),
        "no_room":          (f"no {req_type} with capacity ≥ {strength} is free "
                             f"at any candidate slot."),
    }
    return msgs.get(top, "no valid slot found — check all constraints and availability.")


def _empty_result(errors):
    return {
        "success": False, "entries": [], "issues": errors,
        "summary": {"scheduled_sessions": 0, "unscheduled_sessions": 0,
                    "total_requested_sessions": 0},
        "stats_by_faculty": {}, "stats_by_class": {},
    }


# ────────────────────────────────────────────────────────────────
# Standalone pre-scheduling validation
# ────────────────────────────────────────────────────────────────

def validate_input(data):
    """Return a list of human-readable warnings about the input data."""
    warnings = []
    subjects  = data.get("subjects", [])
    rooms     = data.get("rooms", [])
    classes   = {c["id"]: c for c in data.get("classes", [])}
    batches   = {}
    for c in data.get("classes", []):
        for b in c.get("batches", []):
            batches[b["id"]] = {**b, "class_id": c["id"]}
    days  = data.get("days",  [])
    slots = [s if isinstance(s, dict) else {"id": s} for s in data.get("slots", [])]
    schedulable_slots = [s for s in slots if not s.get("is_break")]

    room_types = {r.get("type", "classroom") for r in rooms}

    for s in subjects:
        name = s.get("name", s.get("id", "?"))
        cid  = s.get("class_id")
        bid  = s.get("batch_id")

        if bid and bid not in batches:
            warnings.append(f"Subject '{name}': batch_id '{bid}' not found in any class.")
        elif not bid and cid and cid not in classes:
            warnings.append(f"Subject '{name}': class_id '{cid}' is unknown.")

        req_type = s.get("room_type", "classroom")
        if req_type not in room_types:
            warnings.append(
                f"Subject '{name}': needs room type '{req_type}' but no such room exists.")

        wp  = int(s.get("weekly_periods", 0) or 0)
        dur = int(s.get("duration", 1) or 1)
        fac = s.get("faculty", "")

        # Check faculty availability count vs required periods
        unavail_set = {
            (x.get("day"), x.get("slot"))
            for x in data.get("faculty_unavailable", [])
            if x.get("faculty") == fac
        }
        available_count = sum(
            1 for day in days
            for slot in schedulable_slots
            if (day, slot["id"]) not in unavail_set
        )
        if wp * dur > available_count:
            warnings.append(
                f"Subject '{name}': requires {wp} session(s) × {dur} slot(s) = "
                f"{wp * dur} slots, but faculty '{fac}' has only {available_count} "
                f"available slots. Some sessions will not be schedulable.")

        if wp * dur > len(days) * len(schedulable_slots):
            warnings.append(
                f"Subject '{name}': {wp} × {dur} slots cannot fit in "
                f"{len(days)} days × {len(schedulable_slots)} schedulable slots.")

    return warnings
