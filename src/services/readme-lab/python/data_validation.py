"""Content identity checks shared by training and offline experiments."""
import hashlib
import json
import unicodedata


def fingerprint(value):
    def clean(x):
        if isinstance(x, str):
            return " ".join(unicodedata.normalize("NFKC", x).split())
        if isinstance(x, dict):
            return {k: clean(v) for k, v in x.items()}
        if isinstance(x, list):
            return [clean(v) for v in x]
        return x
    return hashlib.sha256(json.dumps(clean(value), ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def target_slot(question, label):
    target = list(question["criteria"]).index(label)
    order = question.get("option_order")
    if order is None:
        return target
    if sorted(order) != list(range(len(question["criteria"]))):
        raise ValueError("invalid_option_order")
    return order.index(target)
