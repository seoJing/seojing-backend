"""Offline synthetic Laya head experiment; never loads a candidate in serving.

Select checkpoint with dev NLL, fit temperature on calibration only, then inspect
test once in canonical/reversed order. All labels remain agent-authored. Optional
last encoder layers, fresh local artifacts, explicit config and full predictions.
"""
import argparse
from collections import Counter, defaultdict
from copy import deepcopy
import json
import math
from pathlib import Path
import random
import time
import shutil

import torch
from safetensors.torch import load_file, save_file
from laya.common import collate_items
from runtime import digest, encode_checked, load_agent
from train import QUESTION_SETS
from data_validation import fingerprint


def read_experiment(path):
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if not 1 <= len(rows) <= 10000:
        raise ValueError("dataset_size_invalid")
    ids, groups, families, contents, targets = set(), {}, {}, {}, {}
    for row in rows:
        if (row.get("synthetic") is not True or row.get("human_reviewed") is not False
                or row.get("label_status") != "provisional_agent_authored" or row.get("approved_by")):
            raise ValueError("only_provisional_synthetic_experiments")
        if row["id"] in ids or row["split"] not in {"train", "dev", "calibration", "test"}:
            raise ValueError("duplicate_id_or_invalid_split")
        ids.add(row["id"])
        for field, seen in (("group_id", groups), ("template_family", families)):
            key = row.get(field)
            if not isinstance(key, str) or not key.strip():
                raise ValueError("missing_split_group")
            if key in seen and seen[key] != row["split"]:
                raise ValueError("group_or_template_split_leakage")
            seen[key] = row["split"]
        key = fingerprint({"kind": row["kind"], "state": row["state"]})
        if key in contents and contents[key] != row["split"]:
            raise ValueError("content_split_leakage")
        contents[key] = row["split"]
        previous = targets.setdefault(key, {})
        if any(name in previous and previous[name] != label for name, label in row["labels"].items()):
            raise ValueError("conflicting_labels_for_same_input")
        previous.update(row["labels"])
        questions = QUESTION_SETS[row["kind"]]
        if not row["labels"] or not set(row["labels"]).issubset(questions):
            raise ValueError("invalid_question_labels")
        for name, label in row["labels"].items():
            if label not in questions[name]["criteria"]:
                raise ValueError("invalid_label")
    if {row["split"] for row in rows} != {"train", "dev", "calibration", "test"}:
        raise ValueError("four_splits_required")
    return rows


def ordered_questions(row, rng=None, reverse=False):
    questions = {key: deepcopy(QUESTION_SETS[row["kind"]][key]) for key in row["labels"]}
    for question in questions.values():
        # Permute the actual criteria mapping and recompute target indices below.
        # Do not also set SDK option_order: that would permute a second time.
        question.pop("option_order", None)
        values = list(question["criteria"].items())
        if rng:
            rng.shuffle(values)
        elif reverse:
            values.reverse()
        question["criteria"] = dict(values)
    return questions


def items_for(agent, rows, rng=None, reverse=False):
    result = []
    for row in rows:
        questions = ordered_questions(row, rng, reverse)
        encoded = encode_checked(agent, row["state"], questions, strict_head=True)
        for (key, question), item in zip(questions.items(), encoded):
            labels = list(question["criteria"])
            result.append({"item": item, "id": row["id"], "head": key, "kind": row["kind"],
                           "labels": labels, "target": labels.index(row["labels"][key])})
    return result


def batch_for(agent, items):
    batch = collate_items([[item["item"]] for item in items], agent.tok.pad_token_id)
    tensors = {key: batch[key].to(agent.device) for key in ("input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype")}
    return tensors, torch.tensor([item["target"] for item in items], device=agent.device)


@torch.no_grad()
def evaluate(agent, items, batch_size):
    agent.model.eval()
    records = []
    for start in range(0, len(items), batch_size):
        group = items[start:start + batch_size]
        tensors, _ = batch_for(agent, group)
        logits, _ = agent.model(**tensors)
        for item, values in zip(group, logits.cpu().tolist()):
            records.append({k: item[k] for k in ("id", "head", "kind", "labels", "target")}
                           | {"logits": values[:len(item["labels"])]})
    return records


def scored(records, temperature=1.0):
    result = []
    for r in records:
        probs = torch.softmax(torch.tensor(r["logits"], dtype=torch.float64) / temperature, -1).tolist()
        selected = max(range(len(probs)), key=probs.__getitem__)
        result.append({**r, "probabilities": dict(zip(r["labels"], probs)),
                       "prediction": r["labels"][selected], "expected": r["labels"][r["target"]],
                       "confidence": probs[selected], "correct": selected == r["target"],
                       "nll": -math.log(max(probs[r["target"]], 1e-12)),
                       "brier": sum((p - (i == r["target"])) ** 2 for i, p in enumerate(probs))})
    return result


def summary(records, temperature=1.0):
    values = scored(records, temperature)
    groups = defaultdict(list)
    for row in values:
        groups[f"{row['kind']}.{row['head']}"].append(row)
    def metrics(rows):
        accepted = [r for r in rows if r["confidence"] >= .75]
        confusion = Counter(f"{r['expected']}->{r['prediction']}" for r in rows)
        recalls = []
        for label in sorted({r["expected"] for r in rows}):
            subset = [r for r in rows if r["expected"] == label]
            recalls.append(sum(r["correct"] for r in subset) / len(subset))
        return {"count": len(rows), "correct": sum(r["correct"] for r in rows),
                "accuracy": sum(r["correct"] for r in rows) / len(rows),
                "balanced_accuracy_observed_classes": sum(recalls) / len(recalls),
                "nll": sum(r["nll"] for r in rows) / len(rows),
                "brier": sum(r["brier"] for r in rows) / len(rows),
                "accepted_075": len(accepted), "wrong_accepted_075": sum(not r["correct"] for r in accepted),
                "confusion": dict(confusion)}
    pairs = defaultdict(dict)
    for r in values:
        if r["kind"] == "reader_relation":
            pairs[r["id"]][r["head"]] = r
    complete = []
    relation_accepted = []
    for pair in pairs.values():
        if set(pair) != {"scope", "relation"}:
            continue
        scope, relation = pair["scope"], pair["relation"]
        if (scope["prediction"] == "same" and min(scope["confidence"], relation["confidence"]) >= .75
                and relation["prediction"] in {"complete", "partial", "conflict"}):
            relation_accepted.append(scope["correct"] and relation["correct"])
            if relation["prediction"] == "complete":
                complete.append(scope["expected"] == "same" and relation["expected"] == "complete")
    return {"all": metrics(values), "by_head": {k: metrics(v) for k, v in groups.items()},
            "relation_gate": {"cases": len(pairs), "accepted": len(relation_accepted),
                              "wrong": relation_accepted.count(False),
                              "complete_candidates": len(complete), "false_complete": complete.count(False)}}


def fit_temperature(records):
    # Small synthetic calibration, one scalar with a fixed grid. Does not use dev
    # or test and is not a production probability-calibration certificate.
    grid = [.5, .75, 1., 1.25, 1.5, 2., 3., 4.]
    losses = {str(t): sum(r["nll"] for r in scored(records, t)) / len(records) for t in grid}
    return min(grid, key=lambda t: losses[str(t)]), losses


def order_flips(regular, reversed_records):
    first = {(r["id"], r["head"]): r for r in scored(regular)}
    changed = [r for r in scored(reversed_records) if r["prediction"] != first[(r["id"], r["head"])]["prediction"]]
    return {"decisions": len(regular), "flips": len(changed), "ids": [f"{r['id']}:{r['head']}" for r in changed]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--seed", type=int, default=24)
    parser.add_argument("--encoder-layers", type=int, default=0)
    args = parser.parse_args()
    if (not 1 <= args.epochs <= 20 or not 1 <= args.batch_size <= 16
            or not 0 < args.lr <= .001 or not 0 <= args.encoder_layers <= 4):
        raise ValueError("experiment_config_invalid")
    rows = read_experiment(args.data)
    args.out.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    config = {"synthetic": True, "human_reviewed": False, "production_approved": False,
              "head_only": args.encoder_layers == 0, "encoder_layers": args.encoder_layers,
              "encoder_learning_rate": args.lr / 5, "epochs": args.epochs, "batch_size": args.batch_size,
              "learning_rate": args.lr, "seed": args.seed, "selection": "minimum_dev_nll_including_base",
              "temperature_selection": "calibration_only_grid", "threshold": .75,
              "dataset_sha256": digest(args.data), "script_sha256": digest(Path(__file__)),
              "runtime_sha256": digest(Path(__file__).with_name("runtime.py")),
              "question_sets_sha256": fingerprint(QUESTION_SETS), "counts": dict(Counter(r["split"] for r in rows))}
    (args.out / "config.json").write_text(json.dumps(config, indent=2) + "\n")
    source_dir = args.out / "source"
    source_dir.mkdir()
    for name in ("experiment.py", "runtime.py", "train.py", "data_validation.py"):
        shutil.copyfile(Path(__file__).with_name(name), source_dir / name)
    shutil.copyfile(args.data, source_dir / "dataset.jsonl")
    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)
    agent, metadata = load_agent(args.model.resolve())
    model = agent.model
    last_layers = tuple(f"encoder.layers.{i}." for i in range(len(model.encoder.layers) - args.encoder_layers, len(model.encoder.layers)))
    def retained(name):
        return not name.startswith("encoder.") or name.startswith(last_layers) or (args.encoder_layers > 0 and name.startswith("encoder.final_norm."))
    for name, p in model.named_parameters():
        p.requires_grad_(retained(name) and not name.startswith("act_head."))
    parts = {split: [r for r in rows if r["split"] == split] for split in config["counts"]}
    # Fix validation tokenization once. Test forward is delayed until selection.
    dev_items = items_for(agent, parts["dev"])
    base_state = {n: p.detach().cpu().clone() for n, p in model.state_dict().items() if retained(n)}
    base_dev = evaluate(agent, dev_items, args.batch_size)
    best_nll = summary(base_dev)["all"]["nll"]
    best_epoch = 0
    save_file(base_state, str(args.out / "head.safetensors"))
    optimizer = torch.optim.AdamW([
        {"params": [p for n, p in model.named_parameters() if p.requires_grad and not n.startswith("encoder.")], "lr": args.lr},
        {"params": [p for n, p in model.named_parameters() if p.requires_grad and n.startswith("encoder.")], "lr": args.lr / 5},
    ], weight_decay=.01)
    history = []
    print(json.dumps({"phase": "base_dev", "summary": summary(base_dev)["all"]}), flush=True)
    for epoch in range(1, args.epochs + 1):
        train_items = items_for(agent, parts["train"], rng=rng)
        rng.shuffle(train_items)
        losses = []
        for start in range(0, len(train_items), args.batch_size):
            tensors, target = batch_for(agent, train_items[start:start + args.batch_size])
            model.train(); model.encoder.eval()
            optimizer.zero_grad(set_to_none=True)
            logits, _ = model(**tensors, detach_encoder=args.encoder_layers == 0)
            loss = torch.nn.functional.cross_entropy(logits, target)
            if not torch.isfinite(loss):
                raise ValueError("nonfinite_loss")
            loss.backward()
            torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.)
            optimizer.step()
            losses.append(float(loss.detach().cpu()))
        records = evaluate(agent, dev_items, args.batch_size)
        metrics = summary(records)
        entry = {"epoch": epoch, "train_loss": sum(losses) / len(losses), "dev": metrics, "predictions": records}
        history.append(entry)
        if metrics["all"]["nll"] < best_nll:
            best_nll = metrics["all"]["nll"]; best_epoch = epoch
            save_file({n: p.detach().cpu().contiguous() for n, p in model.state_dict().items() if retained(n)}, str(args.out / "head.safetensors"))
        (args.out / "history.json").write_text(json.dumps(history, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"phase": "epoch", "epoch": epoch, "train_loss": entry["train_loss"], "dev": metrics["all"], "best_epoch": best_epoch}), flush=True)
    model.load_state_dict(load_file(str(args.out / "head.safetensors")), strict=False)
    calibration = evaluate(agent, items_for(agent, parts["calibration"]), args.batch_size)
    temperature, calibration_losses = fit_temperature(calibration)
    test_items = items_for(agent, parts["test"])
    reverse_items = items_for(agent, parts["test"], reverse=True)
    candidate = evaluate(agent, test_items, args.batch_size)
    candidate_reverse = evaluate(agent, reverse_items, args.batch_size)
    model.load_state_dict(base_state, strict=False)
    baseline = evaluate(agent, test_items, args.batch_size)
    baseline_reverse = evaluate(agent, reverse_items, args.batch_size)
    # Reload after actually restoring base weights; verify exported values, not
    # merely reapplying a file over an unchanged trained model.
    model.load_state_dict(load_file(str(args.out / "head.safetensors")), strict=False)
    reloaded = evaluate(agent, test_items, args.batch_size)
    if any(max(abs(a-b) for a, b in zip(x["logits"], y["logits"])) > 1e-5 for x, y in zip(candidate, reloaded)):
        raise ValueError("checkpoint_roundtrip_failed")
    result = {**config, "model": metadata, "precision": "fp32", "best_epoch": best_epoch,
              "head_sha256": digest(args.out / "head.safetensors"), "experimental_temperature": temperature,
              "calibration_grid_nll": calibration_losses, "checkpoint_roundtrip": True,
              "total_ms": round((time.monotonic() - started) * 1000),
              "baseline_test": summary(baseline), "candidate_test": summary(candidate),
              "candidate_test_temperature_scaled": summary(candidate, temperature),
              "baseline_order": order_flips(baseline, baseline_reverse),
              "candidate_order": order_flips(candidate, candidate_reverse),
              "trained_parameters": sum(p.numel() for p in model.parameters() if p.requires_grad),
              "adapter_includes_encoder": args.encoder_layers > 0,
              "limitations": ["Agent-authored small synthetic data; no human gold or promotion approval.",
                              "Partial head supervision; unlabelled heads are not measured.",
                              "One seed; fixed .75 policy is not validated for production.",
                              "Only the configured parameter subset trained; no end-to-end reader quality claim."]}
    (args.out / "predictions.json").write_text(json.dumps({"base_dev": base_dev, "calibration": calibration,
        "baseline_test": scored(baseline), "candidate_test": scored(candidate),
        "baseline_reverse": scored(baseline_reverse), "candidate_reverse": scored(candidate_reverse)}, ensure_ascii=False, indent=2) + "\n")
    (args.out / "metrics.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"phase": "complete", "best_epoch": best_epoch, "baseline": result["baseline_test"]["all"],
                      "candidate": result["candidate_test"]["all"], "order_flips": result["candidate_order"],
                      "total_ms": result["total_ms"]}), flush=True)


if __name__ == "__main__":
    main()
