"""Download a fixed upstream snapshot and record the SDK compatibility mutation."""
import json
from pathlib import Path
import sys

from huggingface_hub import snapshot_download
from laya.agent import _fix_tokenizer_config
from runtime import MODEL_ID, REVISION, digest

target = Path(sys.argv[1]).resolve()
if (target / "manifest.json").exists():
    previous = json.loads((target / "manifest.json").read_text())
    if previous["revision"] != REVISION or any(digest(target / name) != sha for name, sha in previous["runtime_sha256"].items()):
        raise RuntimeError("existing_model_verification_failed")
    print(json.dumps({"ready": True, "revision": REVISION, "existing_verified": True}))
    sys.exit(0)
snapshot_download(MODEL_ID, revision=REVISION, local_dir=target,
                  allow_patterns=["encoder/*", "tokenizer/*", "model.safetensors", "rl_agent_config.json"])
names = ["encoder/config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json",
         "model.safetensors", "rl_agent_config.json"]
source = {name: digest(target / name) for name in names}
_fix_tokenizer_config(str(target))
runtime = {name: digest(target / name) for name in names}
manifest = {"model": MODEL_ID, "revision": REVISION, "sdk": "0.3.25", "source_sha256": source,
            "runtime_sha256": runtime, "compatibility_patch": "laya.agent._fix_tokenizer_config"}
(target / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({"ready": True, "revision": REVISION, "weights_sha256": runtime["model.safetensors"]}))
