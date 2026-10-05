"""Head-only fine-tuning/evaluation. Smoke data is never promoted to production.

Dataset JSONL: id, group_id, split(train|validation), kind(unit|relation|relevance),
state, labels ({question_id: choice_label}), approved_by (human reviewer ID).
Each resume/project group must belong to exactly one split to avoid leakage.
"""
import argparse
import json
from pathlib import Path
import random
import time

import torch
from safetensors.torch import save_file, load_file
from laya.common import collate_items
from data_validation import fingerprint, target_slot
from runtime import QUESTIONS, RELATION, RELEVANCE, READER_UNIT, READER_RELATION, READER_CHECK, REVISION, digest, load_agent, encode_checked

QUESTION_SETS = {"unit": QUESTIONS, "relation": RELATION, "relevance": RELEVANCE,
                 "reader_unit": READER_UNIT, "reader_relation": READER_RELATION, "reader_check": READER_CHECK}


def read_rows(path, smoke=False):
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if not rows or len(rows) > 10000:
        raise ValueError("dataset_size_invalid")
    groups, ids, contents, families, targets = {}, set(), {}, {}, {}
    for row in rows:
        if row["id"] in ids or row["split"] not in ("train", "validation"):
            raise ValueError("duplicate_id_or_invalid_split")
        ids.add(row["id"])
        if row["group_id"] in groups and groups[row["group_id"]] != row["split"]:
            raise ValueError("group_split_leakage")
        groups[row["group_id"]] = row["split"]
        content = fingerprint({"kind": row["kind"], "state": row["state"]})
        if content in contents and contents[content] != row["split"]:
            raise ValueError("content_split_leakage")
        contents[content] = row["split"]
        previous = targets.setdefault(content, {})
        if any(name in previous and previous[name] != label for name, label in row["labels"].items()):
            raise ValueError("conflicting_labels_for_same_input")
        previous.update(row["labels"])
        family = row.get("template_family")
        if family:
            if family in families and families[family] != row["split"]:
                raise ValueError("template_split_leakage")
            families[family] = row["split"]
        if not smoke and (not row.get("approved_by") or row.get("synthetic_smoke")):
            raise ValueError("human_review_required")
        if smoke and not row.get("synthetic_smoke"):
            raise ValueError("smoke_requires_explicit_synthetic_data")
        questions = QUESTION_SETS[row["kind"]]
        if set(row["labels"]) != set(questions):
            raise ValueError("missing_question_labels")
        for key, label in row["labels"].items():
            if label not in questions[key]["criteria"]:
                raise ValueError("invalid_label")
    if {row["split"] for row in rows} != {"train", "validation"}:
        raise ValueError("both_splits_required")
    return rows


def encode(agent, row):
    questions = QUESTION_SETS[row["kind"]]
    items = encode_checked(agent, row["state"], questions, strict_head=True)
    labels = [target_slot(questions[key], row["labels"][key]) for key in questions]
    batch = collate_items([items], agent.tok.pad_token_id)
    keys = ("input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype")
    tensors = {key: batch[key].to(agent.device) for key in keys}
    return tensors, torch.tensor(labels, device=agent.device)


@torch.no_grad()
def evaluate(agent, rows):
    agent.model.eval()
    correct, total = 0, 0
    predictions = []
    started = time.monotonic()
    for row in rows:
        tensors, target = encode(agent, row)
        logits, _ = agent.model(**tensors)
        pred = logits.argmax(-1)
        correct += int((pred == target).sum().item())
        total += len(target)
        predictions.append({"id": row["id"], "prediction_indices": pred.cpu().tolist(), "target_indices": target.cpu().tolist()})
    return {"correct": correct, "total": total, "accuracy": correct / total,
            "elapsed_ms": round((time.monotonic() - started) * 1000), "predictions": predictions}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--steps", type=int, default=100)
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.steps <= 10000 or args.out.exists():
        raise ValueError("invalid_steps_or_existing_output")
    rows = read_rows(args.data, args.smoke)
    torch.manual_seed(24); random.seed(24)
    agent, metadata = load_agent(args.model.resolve())
    training = [row for row in rows if row["split"] == "train"]
    validation = [row for row in rows if row["split"] == "validation"]
    before = evaluate(agent, validation)
    for name, param in agent.model.named_parameters():
        param.requires_grad_(not name.startswith(("encoder.", "act_head.")))
    optimizer = torch.optim.AdamW([p for p in agent.model.parameters() if p.requires_grad], lr=1e-5, weight_decay=0.01)
    losses = []
    started = time.monotonic()
    for step in range(args.steps):
        row = training[step % len(training)]
        tensors, target = encode(agent, row)
        agent.model.train(); agent.model.encoder.eval()
        optimizer.zero_grad(set_to_none=True)
        logits, _ = agent.model(**tensors, detach_encoder=True)
        loss = torch.nn.functional.cross_entropy(logits, target)
        if not torch.isfinite(loss):
            raise ValueError("nonfinite_loss")
        loss.backward(); torch.nn.utils.clip_grad_norm_(agent.model.parameters(), 1.0); optimizer.step()
        losses.append(round(float(loss.detach().cpu()), 6))
    train_ms = round((time.monotonic() - started) * 1000)
    after = evaluate(agent, validation)
    args.out.mkdir(parents=True)
    adapter = {name: value.detach().cpu().contiguous() for name, value in agent.model.state_dict().items() if not name.startswith("encoder.")}
    save_file(adapter, str(args.out / "head.safetensors"))
    # Verify serialization round-trip using the same fixed encoder.
    loaded = load_file(str(args.out / "head.safetensors"))
    agent.model.load_state_dict(loaded, strict=False)
    reloaded = evaluate(agent, validation)
    if reloaded["predictions"] != after["predictions"]:
        raise ValueError("checkpoint_roundtrip_failed")
    result = {"model": metadata, "base_revision": REVISION, "dataset_sha256": digest(args.data),
              "head_sha256": digest(args.out / "head.safetensors"), "steps": args.steps,
              "seed": 24, "head_only": True, "smoke_only": args.smoke,
              "production_approved": False, "calibrated": False, "train_ms": train_ms,
              "losses": losses, "validation_before": before, "validation_after": after,
              "checkpoint_roundtrip": True}
    (args.out / "metrics.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"steps": args.steps, "smoke_only": args.smoke, "before": before["accuracy"], "after": after["accuracy"], "checkpoint_roundtrip": True, "train_ms": train_ms}))


if __name__ == "__main__":
    main()
