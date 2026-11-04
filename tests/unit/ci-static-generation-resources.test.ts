import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
afterEach(()=>{vi.unstubAllEnvs();vi.resetModules();});
describe("CI static generation mitigation",()=>{
  it.each([[undefined,undefined,false],["true",undefined,false],[undefined,"1",false],["false","1",false],["true","0",false],["true","1",true]])("gates workers for github=%s flag=%s",async(github,flag,enabled)=>{
    vi.stubEnv("GITHUB_ACTIONS",github);vi.stubEnv("PROPLANE_CI_SERIAL_STATIC_GENERATION",flag);vi.stubEnv("PROPLANE_LOW_MEMORY_BUILD","0");vi.resetModules();
    const config=(await import("../../next.config")).default;
    expect(config.experimental?.cpus).toBe(enabled?1:undefined);
    expect(config.experimental?.staticGenerationMaxConcurrency).toBe(enabled?1:undefined);
    expect(config.webpack).toBeUndefined(); // Keep Turbopack and Vercel/local defaults.
  });
});
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const children=(pid:number)=>execFileSync("ps",["-axo","pid,ppid,comm"],{encoding:"utf8"}).split("\n").map(line=>line.trim().split(/\s+/)).filter(parts=>Number(parts[1])===pid).map(parts=>Number(parts[0]));
async function observe(status:number,github="true"){
  const dir=mkdtempSync(join(tmpdir(),"ci-build-observer-"));
  const npm=join(dir,"npm");writeFileSync(npm,`#!/usr/bin/env bash\n[ "$*" = "run build" ] || exit 91\nsleep 1\nexit ${status}\n`);chmodSync(npm,0o700);
  let output="",sampler:number|undefined;const descendants=new Set<number>();
  const child=spawn("bash",[resolve("scripts/ci-observe-build.sh")],{env:{...process.env,GITHUB_ACTIONS:github,PATH:`${dir}:${process.env.PATH}`,CI_OBSERVER_PRIVATE_SENTINEL:"observer-fixture-secret-never-log"},stdio:["ignore","pipe","pipe"]});
  child.stdout.on("data",chunk=>{output+=chunk.toString();const match=output.match(/CI resource sampler pid (\d+)/);if(match)sampler=Number(match[1]);});
  child.stderr.on("data",chunk=>{output+=chunk.toString();});
  const poll=setInterval(()=>{if(sampler&&alive(sampler))for(const pid of children(sampler))descendants.add(pid);},30);
  try{
    const code=await new Promise<number|null>((resolveCode,reject)=>{child.once("error",reject);child.once("close",resolveCode);});
    return {code,output,sampler,descendants:[...descendants]};
  }finally{clearInterval(poll);rmSync(dir,{recursive:true,force:true});}
}
describe("actual CI observer shell",()=>{
  it.each([0,17])("preserves build exit %s and reaps sampler plus sleep child",async(status)=>{
    const result=await observe(status);expect(result.code).toBe(status);expect(result.sampler).toBeTypeOf("number");expect(result.descendants.length).toBeGreaterThan(0);
    expect(alive(result.sampler!)).toBe(false);
    for(const pid of result.descendants)expect(alive(pid),`owned sampler child ${pid} survived`).toBe(false);
    expect(result.output).not.toContain("observer-fixture-secret-never-log");expect(result.output).not.toContain("SUPABASE_SERVICE_ROLE_KEY");expect(result.output).not.toContain("--max-old-space-size");
  });
  it("refuses outside GitHub before launching a build",async()=>{const result=await observe(0,"false");expect(result.code).toBe(2);expect(result.sampler).toBeUndefined();});
});
