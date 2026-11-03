// Explicit setup only. Chat startup never downloads executable code.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const { outputFiles } = await build({entryPoints:[new URL('../src/learnHarnessPin.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node'});
const pin = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const target=pin.DEFAULT_SKILL_DIR;
const valid=async()=>{
  for(const [name,hash] of Object.entries(pin.SKILL_HASHES)) {
    if(createHash('sha256').update(await readFile(join(target,name))).digest('hex')!==hash) throw Error('Existing skill installation differs. Preserve it and resolve the mismatch manually.');
  }
};
try {
  await readFile(join(target,'SKILL.md'));
  await valid();
  console.log(`Pinned LearnHarness skill already verified: ${target}`);
} catch(error) {
  if(error.code!=='ENOENT') throw error;
  await mkdir(dirname(target),{recursive:true});
  const staging=await mkdtemp(join(dirname(target),'.install-'));
  try {
    for(const [name,hash] of Object.entries(pin.SKILL_HASHES)) {
      const url=`https://raw.githubusercontent.com/amosblomqvist/learnharness/${pin.LEARNHARNESS_REVISION}/skills/learnharness/${name}`;
      const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
      if(!response.ok) throw Error(`Skill download failed: HTTP ${response.status}`);
      const bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.length>100000||createHash('sha256').update(bytes).digest('hex')!==hash) throw Error(`Skill integrity check failed: ${name}`);
      await mkdir(dirname(join(staging,name)),{recursive:true});
      await writeFile(join(staging,name),bytes,{flag:'wx'});
    }
    await rename(staging,target);
    await valid();
    console.log(`Installed and verified upstream AGPL-3.0-only skill: ${target}`);
  } finally { await rm(staging,{recursive:true,force:true}); }
}
