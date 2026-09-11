import json,os,pathlib,subprocess,tempfile,time
worker=str(pathlib.Path(__file__).resolve().parent.parent/'dist/usage-worker.mjs')
with tempfile.TemporaryDirectory(prefix='skilloom-time-budget-') as directory:
 home=pathlib.Path(directory);app=home/'.config/skilloom';app.mkdir(parents=True)
 path=home/'.agents/skills/probe/SKILL.md';path.parent.mkdir(parents=True);path.write_text('disposable')
 inventory={'version':1,'observedAt':'2026-09-10T00:00:00Z','machine':{'id':'disposable','name':'Disposable','profile':'personal'},'machines':[],'profiles':[],'discovery':{'status':'found','roots':[],'projectsFound':0,'checkoutsFound':0},'globalSkills':[{'name':'probe','path':str(path.parent),'scope':'global','installed':True,'agents':['pi'],'source':None,'reasons':[],'managed':False,'desired':False}],'projects':[],'operations':[]}
 (app/'inventory.json').write_text(json.dumps(inventory))
 root=home/'.pi/agent/sessions';root.mkdir(parents=True)
 for i in range(10000):
  records=[{'type':'session','id':str(i),'cwd':str(home)},{'type':'message','timestamp':'2026-09-10T00:00:00Z','message':{'role':'assistant','content':[{'type':'toolCall','name':'read','id':'r','arguments':{'path':str(path)}}]}},{'type':'message','timestamp':'2026-09-10T00:00:01Z','message':{'role':'toolResult','toolCallId':'r','isError':False}}]
  (root/f'{i}.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in records))
 env={**os.environ,'HOME':directory,'XDG_CONFIG_HOME':str(home/'.config'),'CODEX_HOME':str(home/'.codex'),'CLAUDE_CONFIG_DIR':str(home/'.claude'),'PI_CODING_AGENT_DIR':str(home/'.pi/agent')};env.pop('SKILLOOM_CONFIG',None)
 prior=0
 for run in range(2):
  start=time.monotonic();p=subprocess.run(['node',worker,'usage','backfill','--max-seconds','1'],env=env,text=True,capture_output=True,timeout=15,check=True);elapsed=time.monotonic()-start
  result=json.loads(p.stdout.splitlines()[-1]);saved=json.loads((app/'inventory.json').read_text());count=sum(x['count'] for x in saved['skillUsage']['usage'])
  assert result['paused'] and not result['backfill']['complete'],result
  assert count>prior,(prior,count)
  assert elapsed<5,elapsed
  prior=count
  print(json.dumps({'run':run+1,'seconds':round(elapsed,3),'paused':result['paused'],'filesDiscovered':result['backfill']['filesDiscovered'],'count':count,'resumedWithoutRestart':run==1}))
