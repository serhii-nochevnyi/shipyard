# Local Claude transcript audit. Reads logs only; writes aggregate JSON to --out.
# Input categories remain separate: these are NOT subscription billing units.
# Streamed usage is deduplicated; output may be incomplete (see report).
import argparse
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument('--day',default='2026-09-10')
parser.add_argument('--out',required=True)
args=parser.parse_args()
OUT=Path(args.out); OUT.mkdir(parents=True,exist_ok=True)
import os,json,collections,datetime,statistics
from zoneinfo import ZoneInfo
ROOT=os.path.expanduser('~/.claude/projects'); TZ=ZoneInfo('Europe/Kyiv'); DAY=args.day; midnight=datetime.datetime.fromisoformat(DAY).replace(tzinfo=TZ); START=(midnight-datetime.timedelta(days=6)).astimezone(datetime.timezone.utc).isoformat().replace('+00:00','Z'); END=(midnight+datetime.timedelta(days=1)).astimezone(datetime.timezone.utc).isoformat().replace('+00:00','Z')
FIELDS=['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']
requests={}; naive=collections.Counter(); files=0; bad=0; toolids={}; results={}; errors={}; prompts={}; spawns={}
def local(ts):return datetime.datetime.fromisoformat(ts.replace('Z','+00:00')).astimezone(TZ).isoformat()
for d,_,names in os.walk(ROOT):
 for f in names:
  if not f.endswith('.jsonl'):continue
  files+=1;p=os.path.join(d,f);rel=os.path.relpath(p,ROOT);project=rel.split('/')[0];kind='subagent' if '/subagents/' in rel else 'orchestrator'
  for line in open(p,errors='replace'):
   try:r=json.loads(line)
   except:bad+=1;continue
   ts=r.get('timestamp','');m=r.get('message') or {};content=m.get('content',[])
   if not isinstance(content,list):content=[{'type':'text','text':content}]
   if r.get('type')=='user' and rel not in prompts:
    tx=' '.join(c.get('text','') for c in content if isinstance(c,dict) and c.get('type')=='text')
    if tx:prompts[rel]=tx[:240]
   if not (START<=ts<END):continue
   try:at=local(ts)
   except:continue
   today=at[:10]==DAY;u=m.get('usage');mid=m.get('id');req=r.get('requestId')
   if u and r.get('type')=='assistant' and m.get('model')!='<synthetic>':
    key=(req or '',mid or r.get('uuid') or rel+ts)
    if today:
     naive['rows']+=1
     for k in FIELDS:naive[k]+=u.get(k,0) or 0
    if key not in requests:requests[key]={'ts':at,'model':m.get('model','unknown'),'file':rel,'project':project,'kind':kind,'session':r.get('sessionId'),'agent':r.get('agentId'),'u':dict.fromkeys(FIELDS,0),'w1h':0,'w5m':0,'rows':0,'files':set(),'effort':r.get('effort'),'stop':m.get('stop_reason')}
    q=requests[key];q['rows']+=1;q['files'].add(rel)
    # usage repeated per streamed content block; retain component maxima, never sum snapshots.
    for k in FIELDS:q['u'][k]=max(q['u'][k],u.get(k,0) or 0)
    for k,src in [('w1h','ephemeral_1h_input_tokens'),('w5m','ephemeral_5m_input_tokens')]:q[k]=max(q[k],(u.get('cache_creation') or {}).get(src,0) or 0)
    if m.get('stop_reason'):q['stop']=m['stop_reason']
    if u.get('iterations') and len(u['iterations'])>=len(q.get('iterations',[])):q['iterations']=u['iterations']
   if today:
    for c in content:
     if not isinstance(c,dict):continue
     if c.get('type')=='tool_use':
      tid=c.get('id') or r.get('uuid');inp=c.get('input') or {};toolids[tid]={'name':c.get('name'),'file':rel,'kind':kind,'ts':at,'chars':len(json.dumps(inp,ensure_ascii=False))}
      if c.get('name') in ['Agent','Task']:spawns[tid]={'ts':at,'file':rel,'description':inp.get('description'),'model':inp.get('model','OMITTED'),'type':inp.get('subagent_type'),'prompt_chars':len(inp.get('prompt',''))}
     if c.get('type')=='tool_result':results[c.get('tool_use_id') or r.get('uuid')]={'file':rel,'chars':len(json.dumps(c.get('content',''),ensure_ascii=False)),'error':c.get('is_error',False)}
     tx=c.get('text','')
     if isinstance(tx,str) and ('hit your' in tx or 'rate_limit' in tx) and len(tx)<6000:errors[r.get('uuid') or ts]={'ts':at,'file':rel,'text':tx[:500]}
qs=list(requests.values());today=[q for q in qs if q['ts'][:10]==DAY]
def summary(items):
 u={k:sum(q['u'][k] for q in items) for k in FIELDS};ctx=[sum(q['u'][k] for k in FIELDS[:3]) for q in items];ctx.sort()
 return {'requests':len(items),**u,'context_total':sum(ctx),'context_mean':round(statistics.mean(ctx)) if ctx else 0,'context_p50':round(statistics.median(ctx)) if ctx else 0,'context_p95':ctx[min(len(ctx)-1,int(len(ctx)*.95))] if ctx else 0,'context_max':max(ctx,default=0),'over200k':sum(x>200000 for x in ctx),'over500k':sum(x>500000 for x in ctx),'cache_write_1h':sum(q['w1h'] for q in items),'cache_write_5m':sum(q['w5m'] for q in items),'first':min((q['ts'] for q in items),default=None),'last':max((q['ts'] for q in items),default=None)}
def group(items,key):
 groups=collections.defaultdict(list)
 for q in items:groups[key(q)].append(q)
 return {k:summary(v) for k,v in groups.items()}
filedata=group(today,lambda q:q['file'])
for f,v in filedata.items():v['prompt']=prompts.get(f,'');v['models']=group([q for q in today if q['file']==f],lambda q:q['model']);v['tools']=dict(collections.Counter(t['name'] for t in toolids.values() if t['file']==f));v['tool_result_chars']=sum(t['chars'] for t in results.values() if t['file']==f)
out={'timezone':'Europe/Kyiv','day':DAY,'scanned_files':files,'malformed_lines':bad,'naive_today':dict(naive),'today':summary(today),'days':group(qs,lambda q:q['ts'][:10]),'projects':group(today,lambda q:q['project']),'models':group(today,lambda q:q['model']),'kinds':group(today,lambda q:q['kind']),'hours':group(today,lambda q:q['ts'][:13]),'files':filedata,'tools':dict(collections.Counter(t['name'] for t in toolids.values())),'spawns':list(spawns.values()),'errors':list(errors.values()),'duplicated_across_files':sum(len(q['files'])>1 for q in today),'request_rows_histogram':dict(collections.Counter(q['rows'] for q in today))}

for value in out['files'].values(): value.pop('prompt',None)
for value in out['errors']: value.pop('text',None)
json.dump(out,open(OUT/'summary.json','w'),indent=2,ensure_ascii=False)
for q in qs:q['files']=list(q['files'])
json.dump(qs,open(OUT/'requests.json','w'),ensure_ascii=False)
import json,collections,statistics
r=json.load(open(OUT/'requests.json'));s=json.load(open(OUT/'summary.json'));keys=['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']
adv=[];passes=[];mismatch=[]
for q in r:
 its=q.get('iterations',[])
 for i,it in enumerate(its):
  if it.get('type')=='advisor_message':adv.append({'ts':q['ts'],'file':q['file'],'model':it.get('model'),**{k:it.get(k,0) for k in keys}})
 normal=[it for it in its if it.get('type')=='message']
 if normal and any(sum(it.get(k,0) for it in normal)!=q['u'][k] for k in keys):mismatch.append(q['ts'])
 for it in normal or [q['u']]:passes.append({'ts':q['ts'],'file':q['file'],'kind':q['kind'],'model':q['model'],'context':sum(it.get(k,0) for k in keys[:3])})
today=[x for x in passes if x['ts'][:10]==DAY];at=[a for a in adv if a['ts'][:10]==DAY]
def ctx(xs):
 v=sorted(x['context'] for x in xs);return {'passes':len(v),'mean':round(statistics.mean(v)),'p50':round(statistics.median(v)),'p95':v[int(len(v)*.95)],'max':max(v),'over200k':sum(x>200000 for x in v),'over500k':sum(x>500000 for x in v)}
out={'context_passes':ctx(today),'main_context':ctx([x for x in today if x['kind']=='orchestrator']),'subagent_context':ctx([x for x in today if x['kind']=='subagent']),'iteration_aggregate_mismatches':mismatch,'advisors_today':at,'advisors_by_day':{},'main_sessions':[],'subagent_start_context':{},'active_agent_streams_per_5min':{},'spawns_model':dict(collections.Counter(x['model'] for x in s['spawns']))}
for day in sorted(set(a['ts'][:10] for a in adv)):
 a=[x for x in adv if x['ts'][:10]==day];out['advisors_by_day'][day]={'calls':len(a),**{k:sum(x[k] for x in a) for k in keys}}
for f,v in s['files'].items():
 if '/subagents/' not in f:out['main_sessions'].append({'file':f,**{k:v[k] for k in ['requests','context_total','cache_creation_input_tokens','output_tokens','first','last','tools']},'context':ctx([x for x in today if x['file']==f])})
starts=[]
for f in s['files']:
 if '/subagents/' in f:
  x=min((x for x in today if x['file']==f),key=lambda x:x['ts']);starts.append(x)
out['subagent_start_context']=ctx(starts)
buckets=collections.defaultdict(set)
for x in today:buckets[x['ts'][:14]+str(int(x['ts'][14:16])//5*5).zfill(2)].add(x['file'])
out['peak_active_streams_5min']=max(len(v) for v in buckets.values());out['peak_stream_buckets']=sorted([(k,len(v)) for k,v in buckets.items()],key=lambda x:-x[1])[:5]
json.dump(out,open(OUT/'details.json','w'),ensure_ascii=False,indent=2)
print(f"Audit written to {OUT}")
