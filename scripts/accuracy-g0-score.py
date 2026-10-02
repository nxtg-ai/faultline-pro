#!/usr/bin/env python3
"""Scorer for the pre-registered verdict-accuracy baseline (G0).

Spec: docs/research/2026-10-02-prereg-verdict-accuracy-g0-v1.md, sections 3, 4,
5 and 8, plus amendment A2 (the choices that section leaves open).

    python3 scripts/accuracy-g0-score.py RUN.jsonl [--set full|verify-subsample]
        [--json OUT.json] [--paired OTHER.jsonl]

Reads only the runner's output rows and the committed gold file, so a score is
reproducible at $0. An INVALID run (prereg section 5) is never scored: the
readout lists the reasons and the exit code is 4.

Exit codes: 0 scored, 2 refused (gold hash, unreadable input), 4 INVALID run.
Python 3 and numpy only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Callable, Iterable

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
GOLD_PATH = REPO_ROOT / "docs/research/data/factcheck-bench-subtask4-claim-factuality.jsonl"
SUBSAMPLE_PATH = REPO_ROOT / "docs/research/data/accuracy-g0-verify-subsample-ids.json"
GOLD_SHA256 = "b87f971ce324c87e0427f100fe24b50594b9d44e3a764490b1bef188917dbae1"

SEED = 20260929
RESAMPLES = 2000
FAILURE_SHARE_LIMIT = 0.02

STATUSES = ("supported", "contradicted", "mixed", "unverified")
GOLD_CLASSES = ("true", "false", "not_enough_evidence")
BINARY = ("true", "false")

EXIT_OK, EXIT_REFUSED, EXIT_INVALID = 0, 2, 4

# Prereg section 4. A2.1: "a 4-digit year from 2019 on" is read as 2019 to 2099,
# not touching another digit (so "2020s" matches and "12020" does not).
YEAR_RE = re.compile(r"(?<!\d)20(19|[2-9]\d)(?!\d)")
TIME_WORD_RE = re.compile(r"(?i)\b(current(ly)?|now|today|latest|recent(ly)?|as of|this year)\b")


class Refused(Exception):
    """Input that cannot be scored at all (bad gold hash, unreadable file)."""


# ── Item model ───────────────────────────────────────────────────────────────

def outcome(item: dict) -> str:
    """The scored outcome: a status, or 'failure' for an apiError after retries."""
    if item.get("apiError") is True:
        return "failure"
    status = item.get("status")
    return status if status in STATUSES else "other"


def prediction(item: dict) -> str | None:
    """Prereg section 3: supported -> 'true', contradicted -> 'false'; everything
    else (mixed, unverified, A2.4 unknown statuses, failures) predicts nothing."""
    return {"supported": "true", "contradicted": "false"}.get(outcome(item))


def is_time_sensitive(claim: str) -> bool:
    return bool(YEAR_RE.search(claim) or TIME_WORD_RE.search(claim))


# ── Metrics (vectorised so the bootstrap reuses the same code) ──────────────

def _arrays(items: list[dict]) -> dict[str, np.ndarray]:
    gold = np.array([item["gold"] for item in items])
    pred = np.array([prediction(item) or "" for item in items])
    out = np.array([outcome(item) for item in items])
    return {
        "gold_true": gold == "true",
        "gold_false": gold == "false",
        "correct": pred == gold,
        "covered": pred != "",
        "flagged": np.isin(out, ("contradicted", "mixed")),
    }


def _ratio(numerator: np.ndarray, denominator: np.ndarray) -> np.ndarray:
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(denominator > 0, numerator / np.maximum(denominator, 1), np.nan)


def binary_metrics(a: dict[str, np.ndarray], idx: np.ndarray) -> dict[str, np.ndarray]:
    """Metrics 1-6 of prereg section 4 for each row of an index matrix.

    `idx` has shape (k, n); row j is one resample (or the identity for the point
    estimate). Abstentions and failures are wrong (prereg section 3).
    """
    gt, gf = a["gold_true"][idx], a["gold_false"][idx]
    correct, covered, flagged = a["correct"][idx], a["covered"][idx], a["flagged"][idx]
    recall_true = _ratio((gt & correct).sum(1), gt.sum(1))
    recall_false = _ratio((gf & correct).sum(1), gf.sum(1))
    return {
        "balanced_accuracy": (recall_true + recall_false) / 2,
        "accuracy": correct.mean(1),
        "recall_false": recall_false,
        "recall_true": recall_true,
        "false_flag_rate": _ratio((gf & flagged).sum(1), gf.sum(1)),
        "coverage": covered.mean(1),
        "selective_accuracy": _ratio((covered & correct).sum(1), covered.sum(1)),
    }


def bootstrap_index(n: int) -> np.ndarray:
    """Prereg section 4: the pinned resample matrix over items sorted by id."""
    return np.random.default_rng(SEED).integers(0, n, (RESAMPLES, n))


def _num(value: float) -> float | None:
    return None if value is None or (isinstance(value, float) and math.isnan(value)) else float(value)


def with_ci(items: list[dict], compute: Callable[[dict, np.ndarray], dict[str, np.ndarray]]) -> dict:
    """Point estimate plus 95% percentile CI for every metric `compute` returns.

    A2.3: each metric family is bootstrapped over its own item set (sorted by
    id) with a fresh default_rng(SEED); resamples where a metric is undefined
    (an empty class) are dropped and counted.
    """
    items = sorted(items, key=lambda item: item["id"])
    n = len(items)
    if n == 0:
        return {"n": 0}
    a = _arrays(items)
    point = compute(a, np.arange(n)[None, :])
    boots = compute(a, bootstrap_index(n))
    result: dict = {"n": n}
    for name, values in point.items():
        sample = boots[name][~np.isnan(boots[name])]
        lo, hi = (np.percentile(sample, [2.5, 97.5]) if sample.size else (math.nan, math.nan))
        result[name] = {
            "value": _num(values[0]),
            "ci95": [_num(lo), _num(hi)],
            "undefinedResamples": int(RESAMPLES - sample.size),
        }
    return result


def nee_block(items: list[dict]) -> dict:
    """Prereg section 4: on NEE items, the share returned as unverified or mixed.
    A failure is neither, so it does not count as a hit."""
    items = sorted(items, key=lambda item: item["id"])
    if not items:
        return {"n": 0}
    hits = np.array([outcome(item) in ("unverified", "mixed") for item in items])
    boots = hits[bootstrap_index(len(items))].mean(1)
    lo, hi = np.percentile(boots, [2.5, 97.5])
    return {
        "n": len(items),
        "unverified_or_mixed_share": {"value": float(hits.mean()), "ci95": [float(lo), float(hi)]},
    }


def confusion(items: Iterable[dict]) -> dict:
    columns = list(STATUSES) + ["failure"]
    table = {gold: {column: 0 for column in columns} for gold in GOLD_CLASSES}
    for item in items:
        column = outcome(item)
        if column not in table[item["gold"]]:
            for row in table.values():
                row.setdefault(column, 0)
        table[item["gold"]][column] += 1
    return table


def parse_split(items: Iterable[dict]) -> dict:
    """Prereg section 3 confound: `mixed` from an unparseable reply vs a real one."""
    split = {gold: {"mixed_parse_fallback": 0, "mixed_inconclusive": 0} for gold in GOLD_CLASSES}
    for item in items:
        if outcome(item) == "mixed":
            key = "mixed_parse_fallback" if item.get("parseFallback") is True else "mixed_inconclusive"
            split[item["gold"]][key] += 1
    return split


SUBSET_METRICS = ("balanced_accuracy", "accuracy", "recall_false", "recall_true")


def subset_metrics(a: dict[str, np.ndarray], idx: np.ndarray) -> dict[str, np.ndarray]:
    full = binary_metrics(a, idx)
    return {name: full[name] for name in SUBSET_METRICS}


def score(items: list[dict]) -> dict:
    """Every metric of prereg section 4 from joined items (gold, claim, row)."""
    binary = [item for item in items if item["gold"] in BINARY]
    nee = [item for item in items if item["gold"] == "not_enough_evidence"]
    inside = [item for item in binary if is_time_sensitive(item["claim"])]
    outside = [item for item in binary if not is_time_sensitive(item["claim"])]
    return {
        "binary": with_ci(binary, binary_metrics),
        "confusion": confusion(items),
        "nee": nee_block(nee),
        "time_sensitive": {"inside": with_ci(inside, subset_metrics), "outside": with_ci(outside, subset_metrics)},
        "parse_fallback_split": parse_split(items),
        "unknown_status_count": sum(1 for item in items if outcome(item) == "other"),
    }


# ── Inputs and validity (prereg section 5) ───────────────────────────────────

def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_gold(path: Path) -> list[dict]:
    actual = sha256_file(path)
    if actual != GOLD_SHA256:
        raise Refused(f"gold sha256 {actual} is not {GOLD_SHA256} (prereg section 2)")
    lines = [line for line in path.read_text(encoding="utf-8").split("\n") if line.strip()]
    return [{"id": i, "claim": json.loads(line)["claim"], "gold": json.loads(line)["label"]} for i, line in enumerate(lines)]


def load_rows(path: Path) -> list[dict]:
    try:
        return [json.loads(line) for line in path.read_text(encoding="utf-8").split("\n") if line.strip()]
    except (OSError, json.JSONDecodeError) as error:
        raise Refused(f"cannot read {path}: {error}") from error


def expected_ids(set_name: str, gold: list[dict], subsample_path: Path) -> list[int]:
    if set_name == "full":
        return [item["id"] for item in gold]
    return sorted(json.loads(subsample_path.read_text(encoding="utf-8"))["ids"])


def infer_set(rows: list[dict], gold: list[dict], subsample_path: Path) -> str:
    ids = sorted(row.get("id") for row in rows if isinstance(row.get("id"), int))
    return "verify-subsample" if ids == expected_ids("verify-subsample", gold, subsample_path) else "full"


def validity(rows: list[dict], gold: list[dict], expected: list[int]) -> list[str]:
    """Prereg section 5 run-validity checks; an empty list means valid."""
    reasons: list[str] = []
    ids = [row.get("id") for row in rows]
    if len(ids) != len(set(ids)):
        reasons.append("an id appears more than once")
    missing, extra = set(expected) - set(ids), set(ids) - set(expected)
    if missing:
        reasons.append(f"{len(missing)} expected ids missing (first: {sorted(missing)[:5]})")
    if extra:
        reasons.append(f"{len(extra)} ids outside the set")
    by_id = {item["id"]: item for item in gold}
    mismatched = [row["id"] for row in rows if row.get("id") in by_id and row.get("gold") != by_id[row["id"]]["gold"]]
    if mismatched:
        reasons.append(f"{len(mismatched)} rows carry a gold label that differs from the gold file")
    failures = sum(1 for row in rows if row.get("apiError") is True)
    limit = math.floor(FAILURE_SHARE_LIMIT * len(expected))  # A2.2: 13 of 661, 2 of 100
    if failures > limit:
        reasons.append(f"{failures} failures after retries exceed 2% of {len(expected)} (limit {limit})")
    models = sorted({row["model"] for row in rows if row.get("model")})
    if len(models) > 1:
        reasons.append(f"the engine model changed during the run: {models}")
    shas = sorted({row.get("engineSha") for row in rows})
    if len(shas) > 1:
        reasons.append(f"the engine commit changed during the run: {shas}")
    return reasons


def join(rows: list[dict], gold: list[dict]) -> list[dict]:
    by_id = {item["id"]: item for item in gold}
    return [{**row, "gold": by_id[row["id"]]["gold"], "claim": by_id[row["id"]]["claim"]} for row in rows if row.get("id") in by_id]


def evaluate(run_path: Path, gold: list[dict], set_name: str | None, subsample_path: Path) -> dict:
    rows = load_rows(run_path)
    chosen = set_name or infer_set(rows, gold, subsample_path)
    expected = expected_ids(chosen, gold, subsample_path)
    reasons = validity(rows, gold, expected)
    report = {
        "run": str(run_path),
        "runSha256": sha256_file(run_path),
        "set": chosen,
        "goldSha256": GOLD_SHA256,
        "seed": SEED,
        "resamples": RESAMPLES,
        "valid": not reasons,
        "invalidReasons": reasons,
        "models": sorted({row["model"] for row in rows if row.get("model")}),
        "engineSha": sorted({str(row.get("engineSha")) for row in rows}),
        "failures": sum(1 for row in rows if row.get("apiError") is True),
    }
    if not reasons:
        report["metrics"] = score(join(rows, gold))
    report["_items"] = join(rows, gold)
    return report


# ── Paired comparison (prereg section 8) ─────────────────────────────────────

def paired(primary: list[dict], other: list[dict]) -> dict:
    """Paired bootstrap of BA(primary) - BA(other) on shared binary ids (A2.5)."""
    left = {item["id"]: item for item in primary if item["gold"] in BINARY}
    right = {item["id"]: item for item in other if item["gold"] in BINARY}
    shared = sorted(set(left) & set(right))
    n = len(shared)
    if n == 0:
        return {"n": 0}
    a_left = _arrays([left[i] for i in shared])
    a_right = _arrays([right[i] for i in shared])
    identity = np.arange(n)[None, :]
    idx = bootstrap_index(n)
    point = binary_metrics(a_left, identity)["balanced_accuracy"][0] - binary_metrics(a_right, identity)["balanced_accuracy"][0]
    diffs = binary_metrics(a_left, idx)["balanced_accuracy"] - binary_metrics(a_right, idx)["balanced_accuracy"]
    diffs = diffs[~np.isnan(diffs)]
    agree = float(np.mean([outcome(left[i]) == outcome(right[i]) for i in shared]))
    if diffs.size == 0 or math.isnan(point):
        # Balanced accuracy needs both gold classes among the shared ids.
        return {"n": n, "ba_difference": {"value": None, "ci95": [None, None]},
                "agreement": None, "status_agreement_rate": agree}
    lo, hi = np.percentile(diffs, [2.5, 97.5])
    return {
        "n": n,
        "ba_difference": {"value": float(point), "ci95": [float(lo), float(hi)],
                          "undefinedResamples": int(RESAMPLES - diffs.size)},
        "agreement": bool(lo <= 0 <= hi),
        "status_agreement_rate": agree,
    }


# ── Readout ──────────────────────────────────────────────────────────────────

def _fmt(metric: dict) -> str:
    value, (lo, hi) = metric["value"], metric["ci95"]
    if value is None:
        return "n/a"
    return f"{value:.4f}  [{lo:.4f}, {hi:.4f}]" if lo is not None else f"{value:.4f}"


def readout(report: dict) -> str:
    lines = [f"G0 verdict accuracy: {report['run']}  (set {report['set']}, models {report['models']}, engine {report['engineSha']})"]
    if not report["valid"]:
        lines.append("INVALID RUN (prereg section 5). Not scored:")
        lines += [f"  - {reason}" for reason in report["invalidReasons"]]
        return "\n".join(lines)
    m = report["metrics"]
    b = m["binary"]
    lines.append(f"binary items n={b['n']}, failures={report['failures']}, unknown statuses={m['unknown_status_count']}")
    lines.append(f"HEADLINE balanced accuracy (abstention wrong): {_fmt(b['balanced_accuracy'])}")
    for name in ("accuracy", "recall_false", "recall_true", "false_flag_rate", "coverage", "selective_accuracy"):
        lines.append(f"  {name:<20} {_fmt(b[name])}")
    nee = m["nee"]
    if nee["n"]:
        lines.append(f"NEE n={nee['n']}: unverified-or-mixed share {_fmt(nee['unverified_or_mixed_share'])}")
    for side in ("inside", "outside"):
        block = m["time_sensitive"][side]
        if block["n"]:
            lines.append(f"time-sensitive {side} n={block['n']}: BA {_fmt(block['balanced_accuracy'])}")
    lines.append(f"confusion: {json.dumps(m['confusion'])}")
    lines.append(f"mixed split: {json.dumps(m['parse_fallback_split'])}")
    return "\n".join(lines)


def paired_readout(p: dict, other_name: str) -> str:
    head = f"PAIRED (this run - {other_name}) on {p['n']} shared binary ids: "
    if p.get("agreement") is None:
        return head + "balanced accuracy undefined (both gold classes are needed); no agreement verdict."
    diff = p["ba_difference"]
    verdict = "AGREEMENT" if p["agreement"] else "NO AGREEMENT"
    return (head + f"BA difference {diff['value']:.4f} [{diff['ci95'][0]:.4f}, {diff['ci95'][1]:.4f}] -> {verdict}; "
            f"per-item status agreement {p['status_agreement_rate']:.4f}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("run", type=Path)
    parser.add_argument("--set", choices=("full", "verify-subsample"))
    parser.add_argument("--json", type=Path, dest="json_out")
    parser.add_argument("--paired", type=Path)
    parser.add_argument("--gold", type=Path, default=GOLD_PATH)
    parser.add_argument("--subsample", type=Path, default=SUBSAMPLE_PATH)
    args = parser.parse_args(argv)
    try:
        gold = load_gold(args.gold)
        report = evaluate(args.run, gold, args.set, args.subsample)
        other = evaluate(args.paired, gold, None, args.subsample) if args.paired else None
    except Refused as error:
        print(f"REFUSED: {error}", file=sys.stderr)
        return EXIT_REFUSED
    print(readout(report))
    exit_code = EXIT_OK if report["valid"] else EXIT_INVALID
    if other is not None:
        print(readout(other))
        if report["valid"] and other["valid"]:
            report["paired"] = {"other": str(args.paired), **paired(report["_items"], other["_items"])}
            print(paired_readout(report["paired"], args.paired.name))
        else:
            print("PAIRED comparison not made: a run is INVALID.")
            exit_code = EXIT_INVALID
    if args.json_out:
        public = {key: value for key, value in report.items() if key != "_items"}
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(public, indent=2) + "\n", encoding="utf-8")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
