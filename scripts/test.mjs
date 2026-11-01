import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=['plugin','service/cider-marshall-isolated','service/cider-marshall-streaming-lab'].flatMap(folder=>fs.readdirSync(path.join(root,folder)).filter(name=>name.endsWith('.test.mjs')).map(name=>path.join(root,folder,name)));
if(!process.env.CIDER_CAST_FFPLAY)throw Error('Set CIDER_CAST_FFPLAY to ffplay.exe for the synthetic local-player test. No music is recorded.');
const result=spawnSync(process.execPath,['--test','--test-timeout=35000',...files],{stdio:'inherit',windowsHide:true});
process.exitCode=result.status??1;
