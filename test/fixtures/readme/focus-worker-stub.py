import json,sys,time
config=json.loads(sys.stdin.readline())
case=json.load(open(__file__.replace("focus-worker-stub.py","focus-recorded-v1.json")))["cases"][0]
print(json.dumps({"ready":{"model":"jev-1.13.0","provider":"typesafe","execution":"remote","calibrated_for_readme":False},"version":"focus-reader-v1"}),flush=True)
for line in sys.stdin:
 message=json.loads(line)
 metrics={k:0 for k in ["calls","input_tokens","output_tokens","steps","retrievals","abstentions","limited"]}
 if message.get("finish"):
  print(json.dumps({"id":message["id"],"snapshot":{"version":"focus-reader-v1","frontier_unit_id":"u3","questions":case["questions"]},"metrics":metrics}),flush=True)
  break
 data=message["input"]
 if data["role_context"]=="stall":time.sleep(60)
 i=len(data["prefix"])-1
 if data["role_context"]=="fail" and i==1:
  print(json.dumps({"id":message["id"],"error":"engine_unavailable","metrics":metrics}),flush=True)
  break
 print(json.dumps({"id":message["id"],"result":case["trace"][i],"metrics":metrics}),flush=True)
