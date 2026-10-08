import json,sys,time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "src/services/readme-lab/python"))
from jev_focus_reader import DIAGNOSTIC_KEYS
config=json.loads(sys.stdin.readline())
case=json.load(open(__file__.replace("focus-worker-stub.py","focus-recorded-v1.json")))["cases"][0]
print(json.dumps({"ready":{"model":"jev-1.13.0","provider":"typesafe","execution":"remote","calibrated_for_readme":False},"version":"focus-reader-v1"}),flush=True)
telemetry={}
for line in sys.stdin:
 message=json.loads(line)
 metrics={k:0 for k in ["calls","input_tokens","output_tokens","steps","retrievals","abstentions","limited"]}
 if message.get("finish"):
  print(json.dumps({"id":message["id"],"snapshot":{"version":"focus-reader-v1","frontier_unit_id":"u3","questions":case["questions"]},"metrics":metrics,**telemetry}),flush=True)
  break
 data=message["input"]
 if data["role_context"] in ("diagnostics", "invalid-diagnostics"):
  telemetry={"diagnostics":dict.fromkeys(DIAGNOSTIC_KEYS,0)}
  telemetry["diagnostics"]["fallback_rechecks"]=1
  if data["role_context"]=="invalid-diagnostics":telemetry["diagnostics"]["source"]="must-never-be-logged"
 if data["role_context"]=="stall":time.sleep(60)
 i=len(data["prefix"])-1
 if data["role_context"]=="fail" and i==1:
  print(json.dumps({"id":message["id"],"error":"engine_unavailable","metrics":metrics}),flush=True)
  break
 print(json.dumps({"id":message["id"],"result":case["trace"][i],"metrics":metrics,**telemetry}),flush=True)
