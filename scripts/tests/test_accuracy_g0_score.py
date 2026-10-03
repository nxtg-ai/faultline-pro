"""Tests for scripts/accuracy-g0-score.py (prereg G0 sections 3, 4, 5, 6, 8).

Validates: prereg G0 section 6 "the scorer must be able to fail" and the
section 4 metrics on a fixture whose numbers are computed by hand below.
Run: python3 -m pytest scripts/tests -q
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "accuracy-g0-score.py"
_spec = importlib.util.spec_from_file_location("accuracy_g0_score", SCRIPT)
scorer = importlib.util.module_from_spec(_spec)
sys.modules["accuracy_g0_score"] = scorer
_spec.loader.exec_module(scorer)

GOLD = scorer.load_gold(scorer.GOLD_PATH)
SUBSAMPLE = sorted(json.loads(scorer.SUBSAMPLE_PATH.read_text())["ids"])


def item(i, gold, status, api_error=False, parse_fallback=False, claim="A claim."):
    return {"id": i, "gold": gold, "status": status, "apiError": api_error,
            "parseFallback": parse_fallback, "claim": claim}


# Hand-computed fixture: 6 true, 4 false, 2 NEE.
#   true : 0,1,2 supported (right) · 3 mixed/parse-fallback (abstain) · 4 contradicted (wrong) · 5 failure
#   false: 6,7,9 contradicted (right) · 8 mixed/inconclusive (abstain)
#   NEE  : 10 unverified (hit) · 11 supported (miss)
FIXTURE = [
    item(0, "true", "supported", claim="In 2021 the stadium opened."),
    item(1, "true", "supported", claim="It is currently the largest."),
    item(2, "true", "supported"),
    item(3, "true", "mixed", parse_fallback=True),
    item(4, "true", "contradicted"),
    item(5, "true", "unverified", api_error=True),
    item(6, "false", "contradicted", claim="As of 2023 it was closed."),
    item(7, "false", "contradicted"),
    item(8, "false", "mixed"),
    item(9, "false", "contradicted"),
    item(10, "not_enough_evidence", "unverified"),
    item(11, "not_enough_evidence", "supported"),
]


def value(block, name):
    return block[name]["value"]


class TestHandComputedFixture:
    def test_headline_and_binary_metrics(self):
        b = scorer.score(FIXTURE)["binary"]
        assert b["n"] == 10
        # recall_true = 3/6, recall_false = 3/4, BA = (0.5 + 0.75) / 2
        assert value(b, "recall_true") == pytest.approx(0.5)
        assert value(b, "recall_false") == pytest.approx(0.75)
        assert value(b, "balanced_accuracy") == pytest.approx(0.625)
        assert value(b, "accuracy") == pytest.approx(0.6)            # 6 right of 10
        assert value(b, "false_flag_rate") == pytest.approx(1.0)     # 6,7,9 contradicted + 8 mixed
        assert value(b, "coverage") == pytest.approx(0.7)            # 0,1,2,4,6,7,9
        assert value(b, "selective_accuracy") == pytest.approx(6 / 7)

    def test_ci_brackets_the_point_estimate(self):
        ba = scorer.score(FIXTURE)["binary"]["balanced_accuracy"]
        lo, hi = ba["ci95"]
        assert lo <= ba["value"] <= hi
        assert lo < hi

    def test_confusion_matrix(self):
        c = scorer.score(FIXTURE)["confusion"]
        assert c["true"] == {"supported": 3, "contradicted": 1, "mixed": 1, "unverified": 0, "failure": 1}
        assert c["false"] == {"supported": 0, "contradicted": 3, "mixed": 1, "unverified": 0, "failure": 0}
        assert c["not_enough_evidence"] == {"supported": 1, "contradicted": 0, "mixed": 0, "unverified": 1, "failure": 0}

    def test_nee_share_and_parse_split(self):
        m = scorer.score(FIXTURE)
        assert m["nee"]["n"] == 2
        assert value(m["nee"], "unverified_or_mixed_share") == pytest.approx(0.5)
        assert m["parse_fallback_split"]["true"] == {"mixed_parse_fallback": 1, "mixed_inconclusive": 0}
        assert m["parse_fallback_split"]["false"] == {"mixed_parse_fallback": 0, "mixed_inconclusive": 1}

    def test_time_sensitive_subset(self):
        ts = scorer.score(FIXTURE)["time_sensitive"]
        assert ts["inside"]["n"] == 3      # ids 0, 1, 6
        assert ts["outside"]["n"] == 7
        assert value(ts["inside"], "balanced_accuracy") == pytest.approx(1.0)


class TestScorerCanFail:
    """Prereg section 6: shown red on a mutation before the real run is scored."""

    def test_all_supported_scores_exactly_half(self):
        items = [item(g["id"], g["gold"], "supported", claim=g["claim"]) for g in GOLD]
        b = scorer.score(items)["binary"]
        assert b["n"] == 631
        assert value(b, "balanced_accuracy") == 0.5
        assert value(b, "accuracy") == pytest.approx(472 / 631)

    def test_flipping_one_gold_label_changes_balanced_accuracy(self):
        flipped = [dict(x) for x in FIXTURE]
        flipped[4]["gold"] = "false"   # the contradicted 'true' item becomes a correct 'false'
        before = value(scorer.score(FIXTURE)["binary"], "balanced_accuracy")
        after = value(scorer.score(flipped)["binary"], "balanced_accuracy")
        assert after != before
        assert after == pytest.approx((3 / 5 + 4 / 5) / 2)

    def test_abstention_rule_mutation_turns_red(self, monkeypatch):
        """Mutate 'mixed is an abstention' into 'mixed predicts false': the fixture must move."""
        original = scorer.prediction

        def mutated(it):
            return "false" if scorer.outcome(it) == "mixed" else original(it)

        monkeypatch.setattr(scorer, "prediction", mutated)
        b = scorer.score(FIXTURE)["binary"]
        assert value(b, "balanced_accuracy") != pytest.approx(0.625)
        assert value(b, "balanced_accuracy") == pytest.approx((3 / 6 + 4 / 4) / 2)


class TestTimeSensitiveRegex:
    @pytest.mark.parametrize("text", ["In 2019 it rained.", "the 2020s", "by 2099", "Currently open.",
                                      "open now", "as of May", "the latest model", "this year", "recently built"])
    def test_matches(self, text):
        assert scorer.is_time_sensitive(text)

    @pytest.mark.parametrize("text", ["In 2018 it rained.", "zip 12020", "nowhere to go", "a 1999 film",
                                      "the currents are strong", "page 2100"])
    def test_does_not_match(self, text):
        assert not scorer.is_time_sensitive(text)


class TestPaired:
    def test_identical_runs_agree_with_zero_difference(self):
        p = scorer.paired(FIXTURE, FIXTURE)
        assert p["n"] == 10
        assert p["ba_difference"]["value"] == 0
        assert p["ba_difference"]["ci95"] == [0.0, 0.0]
        # A3: item 5 failed in both runs, and a failure is a disagreement, so 9 of 10.
        assert p["status_agreement_rate"] == pytest.approx(0.9)
        assert p["agreement"] is True and p["verdict"] == "AGREEMENT"

    def test_very_different_runs_do_not_agree(self):
        binary = [item(g["id"], g["gold"], "supported" if g["gold"] == "true" else "contradicted")
                  for g in GOLD if g["id"] in set(SUBSAMPLE)]
        everything_supported = [dict(x, status="supported") for x in binary]
        p = scorer.paired(binary, everything_supported)
        assert p["n"] == 100
        assert p["ba_difference"]["value"] == pytest.approx(0.5)
        assert p["agreement"] is False
        assert p["status_agreement_rate"] < 1.0

    def test_only_shared_binary_ids_enter(self):
        p = scorer.paired(FIXTURE, FIXTURE[:8])
        assert p["n"] == 8

    def test_one_gold_class_only_cannot_show_agreement(self):
        p = scorer.paired(FIXTURE, FIXTURE[:4])   # ids 0-3 are all gold 'true'
        assert p["n"] == 4
        assert p["ba_difference"]["value"] is None and p["ci_contains_zero"] is None
        # A3 (ii) cannot be shown without a CI, so the verdict is NOT REPRODUCED.
        assert p["ci_within_margin"] is False
        assert p["agreement"] is False and p["verdict"] == "NOT REPRODUCED"


# ── Prereg A3: the section 8 agreement rule ─────────────────────────────────

SUB_GOLD = {g["id"]: g["gold"] for g in GOLD if g["id"] in set(SUBSAMPLE)}
SUB_TRUE = [i for i in SUBSAMPLE if SUB_GOLD[i] == "true"]     # 79
SUB_FALSE = [i for i in SUBSAMPLE if SUB_GOLD[i] == "false"]   # 21
RIGHT = {"true": "supported", "false": "contradicted"}
WRONG = {"true": "contradicted", "false": "supported"}


def sub_run(correct_ids):
    return [item(i, SUB_GOLD[i], RIGHT[SUB_GOLD[i]] if i in correct_ids else WRONG[SUB_GOLD[i]]) for i in SUBSAMPLE]


def flipped(run, ids):
    swap = {"supported": "contradicted", "contradicted": "supported"}
    return [dict(r, status=swap[r["status"]]) if r["id"] in ids else r for r in run]


# A realistic original: 1 in 5 true items wrong (16), about half the false items right (11).
WRONG_TRUE = SUB_TRUE[::5]
RIGHT_TRUE = [i for i in SUB_TRUE if i not in set(WRONG_TRUE)]
RIGHT_FALSE = SUB_FALSE[::2]
ORIGINAL = sub_run(set(RIGHT_TRUE) | set(RIGHT_FALSE))


def balanced_true_flips(k):
    """k flips on true items, half right->wrong and half wrong->right, so the BA
    point difference stays near 0 and the CI sits well inside +/-0.10: only the
    per-item floor can separate these cases."""
    return set(RIGHT_TRUE[: k - k // 2]) | set(WRONG_TRUE[: k // 2])


class TestA3Agreement:
    def test_fixture_shape(self):
        assert len(SUB_TRUE) == 79 and len(SUB_FALSE) == 21
        assert len(WRONG_TRUE) == 16 and len(RIGHT_FALSE) == 11

    def test_codex_all_opposite_runs_are_not_reproduced(self):
        """Reviewer fixture (codex, al:d9dff4d8f98c5bc2): every prediction opposite.
        The old rule (CI contains 0) called this AGREEMENT."""
        original = sub_run(set(SUB_TRUE[1::2]) | set(SUB_FALSE[1::2]))
        rerun = flipped(original, set(SUBSAMPLE))
        p = scorer.paired(rerun, original)
        assert p["n"] == 100
        assert p["ba_difference"]["value"] == pytest.approx(0.0301, abs=5e-5)
        assert p["ba_difference"]["ci95"] == pytest.approx([-0.2075, 0.2832], abs=5e-5)
        assert p["status_agreement_rate"] == 0.0
        assert p["ci_contains_zero"] is True          # what the shipped rule judged on
        assert p["status_agreement_met"] is False and p["ci_within_margin"] is False
        assert p["verdict"] == "NOT REPRODUCED" and p["agreement"] is False

    def test_identical_subsample_runs_agree(self):
        p = scorer.paired(ORIGINAL, ORIGINAL)
        assert p["status_agreement_rate"] == 1.0
        assert p["ba_difference"]["ci95"] == [0.0, 0.0]
        assert p["verdict"] == "AGREEMENT"

    def test_ten_flips_inside_the_margin_agree(self):
        p = scorer.paired(flipped(ORIGINAL, balanced_true_flips(10)), ORIGINAL)
        assert p["status_agreement_rate"] == pytest.approx(0.90)
        lo, hi = p["ba_difference"]["ci95"]
        assert -0.10 <= lo < 0 < hi <= 0.10
        assert p["verdict"] == "AGREEMENT"

    def test_fifteen_flips_is_exactly_the_floor_and_agrees(self):
        p = scorer.paired(flipped(ORIGINAL, balanced_true_flips(15)), ORIGINAL)
        assert p["status_agreement_rate"] == pytest.approx(0.85)
        assert p["ci_within_margin"] is True
        assert p["verdict"] == "AGREEMENT"

    def test_sixteen_flips_fail_the_floor_even_with_the_ci_inside(self):
        p = scorer.paired(flipped(ORIGINAL, balanced_true_flips(16)), ORIGINAL)
        assert p["status_agreement_rate"] == pytest.approx(0.84)
        assert p["ci_within_margin"] is True          # (ii) holds; only (i) fails
        assert p["status_agreement_met"] is False
        assert p["verdict"] == "NOT REPRODUCED"

    def test_high_agreement_but_ci_outside_the_margin_is_not_reproduced(self):
        ten_false = set(RIGHT_FALSE[:10])             # right -> wrong, all one way
        p = scorer.paired(flipped(ORIGINAL, ten_false), ORIGINAL)
        assert p["status_agreement_rate"] == pytest.approx(0.90)
        assert p["status_agreement_met"] is True      # (i) holds; only (ii) fails
        lo, hi = p["ba_difference"]["ci95"]
        assert lo < -0.10
        assert p["ci_within_margin"] is False
        assert p["verdict"] == "NOT REPRODUCED"

    def test_a_failure_in_both_runs_is_a_disagreement(self):
        original = [dict(r, apiError=True, status="unverified") if r["id"] == SUBSAMPLE[0] else r for r in ORIGINAL]
        p = scorer.paired(original, original)
        assert p["status_agreement_rate"] == pytest.approx(0.99)

    def test_ci_on_the_margin_counts_as_inside(self):
        assert scorer.a3_verdict(0.85, [-0.10, 0.10])["verdict"] == "AGREEMENT"
        assert scorer.a3_verdict(0.85, [-0.1001, 0.0])["verdict"] == "NOT REPRODUCED"
        assert scorer.a3_verdict(0.8499, [0.0, 0.0])["verdict"] == "NOT REPRODUCED"


# ── CLI: validity (prereg section 5) on files ───────────────────────────────

def write_run(path: Path, ids, *, failures=0, models=None, shas=None, status="supported"):
    rows = []
    for k, i in enumerate(ids):
        failed = k < failures
        rows.append({
            "id": i, "gold": GOLD[i]["gold"], "status": "unverified" if failed else status,
            "apiError": failed, "parseFallback": False, "attempts": 4 if failed else 1,
            "model": None if failed else (models[k] if models else "gemini-2.5-flash"),
            "engineSha": shas[k] if shas else "4de048a", "ts": "2026-10-02T00:00:00Z",
        })
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    return path


def cli(*args):
    return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], capture_output=True, text=True)


ALL_IDS = list(range(661))


class TestCli:
    def test_full_all_supported_is_valid_and_scores_half(self, tmp_path):
        run = write_run(tmp_path / "run.jsonl", ALL_IDS)
        out = tmp_path / "score.json"
        r = cli(run, "--json", out)
        assert r.returncode == 0, r.stdout + r.stderr
        report = json.loads(out.read_text())
        assert report["valid"] is True
        assert report["set"] == "full"
        assert report["metrics"]["binary"]["balanced_accuracy"]["value"] == 0.5
        assert "HEADLINE balanced accuracy" in r.stdout

    def test_thirteen_failures_valid_fourteen_invalid(self, tmp_path):
        assert cli(write_run(tmp_path / "a.jsonl", ALL_IDS, failures=13)).returncode == 0
        r = cli(write_run(tmp_path / "b.jsonl", ALL_IDS, failures=14), "--json", tmp_path / "b.json")
        assert r.returncode == 4
        assert "INVALID" in r.stdout and "HEADLINE" not in r.stdout
        report = json.loads((tmp_path / "b.json").read_text())
        assert report["valid"] is False and "metrics" not in report

    def test_subsample_failure_limit_is_two(self, tmp_path):
        assert cli(write_run(tmp_path / "a.jsonl", SUBSAMPLE, failures=2)).returncode == 0
        assert cli(write_run(tmp_path / "b.jsonl", SUBSAMPLE, failures=3)).returncode == 4

    def test_model_change_is_invalid(self, tmp_path):
        models = ["gemini-2.5-flash"] * 660 + ["gemini-3.0-pro"]
        r = cli(write_run(tmp_path / "run.jsonl", ALL_IDS, models=models))
        assert r.returncode == 4 and "model changed" in r.stdout

    def test_engine_commit_change_is_invalid(self, tmp_path):
        shas = ["4de048a"] * 600 + ["0707f24"] * 61
        r = cli(write_run(tmp_path / "run.jsonl", ALL_IDS, shas=shas))
        assert r.returncode == 4 and "commit changed" in r.stdout

    def test_missing_and_duplicate_ids_are_invalid(self, tmp_path):
        assert cli(write_run(tmp_path / "a.jsonl", ALL_IDS[:-1])).returncode == 4
        assert cli(write_run(tmp_path / "b.jsonl", ALL_IDS + [0])).returncode == 4

    def test_gold_hash_mismatch_refuses(self, tmp_path):
        tampered = tmp_path / "gold.jsonl"
        shutil.copy(scorer.GOLD_PATH, tampered)
        tampered.write_text(tampered.read_text().replace('"label":"false"', '"label":"true"', 1))
        r = cli(write_run(tmp_path / "run.jsonl", ALL_IDS), "--gold", tampered)
        assert r.returncode == 2 and "REFUSED" in r.stderr

    def test_paired_identical_subsample_runs_agree(self, tmp_path):
        a = write_run(tmp_path / "a.jsonl", SUBSAMPLE)
        b = write_run(tmp_path / "b.jsonl", SUBSAMPLE)
        out = tmp_path / "p.json"
        r = cli(a, "--paired", b, "--json", out)
        assert r.returncode == 0, r.stdout + r.stderr
        p = json.loads(out.read_text())["paired"]
        lo, hi = p["ba_difference"]["ci95"]
        assert lo <= 0 <= hi and p["agreement"] is True and p["n"] == 100
        assert p["verdict"] == "AGREEMENT"
        assert "VERDICT: AGREEMENT" in r.stdout

    def test_paired_readout_prints_both_components_and_not_reproduced(self, tmp_path):
        a = write_run(tmp_path / "a.jsonl", SUBSAMPLE, status="supported")
        b = write_run(tmp_path / "b.jsonl", SUBSAMPLE, status="contradicted")
        r = cli(a, "--paired", b)
        assert r.returncode == 0, r.stdout + r.stderr   # a verdict, not an invalid run
        assert "(i)  per-item status agreement 0.0000" in r.stdout
        assert "(ii) BA difference" in r.stdout
        assert "VERDICT: NOT REPRODUCED" in r.stdout

    def test_paired_against_full_run_uses_the_shared_ids(self, tmp_path):
        sub = write_run(tmp_path / "sub.jsonl", SUBSAMPLE)
        full = write_run(tmp_path / "full.jsonl", ALL_IDS)
        out = tmp_path / "p.json"
        assert cli(sub, "--paired", full, "--json", out).returncode == 0
        report = json.loads(out.read_text())
        assert report["set"] == "verify-subsample"
        assert report["paired"]["n"] == 100

    def test_bootstrap_matrix_is_the_pinned_one(self):
        idx = scorer.bootstrap_index(631)
        expected = np.random.default_rng(20260929).integers(0, 631, (2000, 631))
        assert idx.shape == (2000, 631)
        assert np.array_equal(idx, expected)
