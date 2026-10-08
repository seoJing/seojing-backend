"""Authored synthetic protocol fixture, never a real-model outcome."""
import json
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'src/services/readme-lab/python'))
from jev_focus_reader import DIAGNOSTIC_KEYS as FOCUS_KEYS
from jev_situation_reader import DIAGNOSTIC_KEYS as SITUATION_KEYS

def send(x): print(json.dumps(x, ensure_ascii=False), flush=True)
config=json.loads(sys.stdin.readline())
send({'version':'situation-reader-v1','ready':{'model':'jev-1.13.0','provider':'typesafe','execution':'remote','calibrated_for_readme':False}})
cases=json.loads((Path(__file__).parent/'situation-contract-v1.json').read_text())['cases']
count=0; mode='normal'; case=None
for line in sys.stdin:
 m=json.loads(line)
 if 'input' in m:
  parts=m['input']['role_context'].split(':');name=parts[0];mode=parts[1] if len(parts)>1 else 'normal'
  case=next(c for c in cases if c['id']==name)
  if count==1 and mode=='stall':time.sleep(10)
  result=case['steps'][count]; count+=1
 else:
  if mode=='finish-stall':time.sleep(10)
  result=case['finish']
  if mode=='finish-fail':result['final_events']=[]
 metrics=dict(calls=count,input_tokens=count*10,output_tokens=count,steps=count,retrievals=0,abstentions=0,limited=0)
 diag={'focus':dict.fromkeys(FOCUS_KEYS,0),'situation':{**dict.fromkeys(SITUATION_KEYS,0),'provider_retries':0}}
 if mode=='invalid-diagnostic':diag['situation']['raw_source']='never-log-this'
 if mode=='invalid-step' and count==2 and 'input' in m:result['events'][1]['expectation']['evidence'][0]['quote']='fabricated'
 if mode=='fail' and count==2 and 'input' in m:
  send({'id':m['id'],'error':'engine_unavailable','metrics':metrics,'diagnostics':diag});break
 response={'id':m['id'],'result':result,'metrics':metrics,'diagnostics':diag}
 if mode=='duplicate-step' and 'input' in m or mode=='duplicate-finish' and 'finish' in m:
  # One write forces both responses into the same stdout read/line processing turn.
  sys.stdout.write(json.dumps(response)+'\n'+json.dumps(response)+'\n');sys.stdout.flush()
 elif mode=='unsolicited-step' and 'input' in m:
  sys.stdout.write(json.dumps(response)+'\n'+json.dumps({**response,'id':'unsolicited'})+'\n');sys.stdout.flush()
 else:send(response)
 if 'finish' in m:break
