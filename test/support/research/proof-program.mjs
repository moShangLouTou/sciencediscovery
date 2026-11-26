// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
export const PROOF_PROGRAM = `import hashlib,json,os,sys,time
control,execution,inputs,index=sys.argv[1:5]
def status(phase,**extra):
    temporary=os.path.join(control,".status")
    with open(temporary,"w") as f: json.dump(dict(version=1,execution=execution,phase=phase,**extra),f)
    os.replace(temporary,os.path.join(control,"status"))
status("research")
item=json.loads(index)["files"][0]
with open(os.path.join(inputs,item["path"]),"rb") as f: data=f.read()
assert hashlib.sha256(data).hexdigest()==item["sha256"]
time.sleep(.1)
status("reporting",outcome="completed",report="generating")
with open("proof.txt","w") as f: f.write("checked: "+data.decode())
time.sleep(.1)
status("finished",outcome="completed",report="ready")
`;
