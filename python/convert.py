"""Seed-VC voice conversion for Demo studio's voice "mine": one process, many scenes.

Started by src/voice-mine-local.ts from the extension's venv. Talks in JSON lines:

  stdin   one request per line: {"id", "source", "target", "output", "variant"}
          source  the reading to convert (a WAV), target the reference voice (a WAV),
          output  where the converted WAV goes, variant "a" or "b"
  stdout  {"ready": true} once the GPU and Seed-VC are in place, then one answer per request:
          {"id": n} or {"id": n, "error": "...", "code": "..."}; a failure before ready has no id.
          Everything else Seed-VC prints goes to stderr.

The conversion is Seed-VC's own inference.py `main(args)` with the settings the reader's golden
tests used, so nothing differs from running

  inference.py --source S --target T --diffusion-steps 100 --length-adjust 1.0
               --inference-cfg-rate 0.7 --fp16 True <variant flags>

except that the models load once instead of once per scene (`load_models` is memoised).
Variant B (default): --f0-condition True --auto-f0-adjust True, the 44.1 kHz model.
Variant A: --f0-condition False --auto-f0-adjust False, the 22 kHz model.

Seed-VC is not on PyPI. The pinned commit is fetched on first run as a zip from GitHub into
<home>/seed-vc/<commit>/, and its checkpoints download into that folder's ./checkpoints (Seed-VC
resolves them relative to its working directory) on first use, roughly 1 to 1.5 GB per variant
(an estimate from the model files, not measured). HF_HOME is set to <home>/hf; nothing goes to the
user's own caches.
"""

import argparse
import glob
import json
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from types import SimpleNamespace

SEED_VC_COMMIT = "51383efd921027683c89e5348211d93ff12ac2a8"
SEED_VC_ZIP = f"https://github.com/Plachtaa/seed-vc/archive/{SEED_VC_COMMIT}.zip"

# The reader's settings, as Seed-VC's inference.py takes them.
DIFFUSION_STEPS = 100
LENGTH_ADJUST = 1.0
INFERENCE_CFG_RATE = 0.7
FP16 = True
VARIANTS = {
    "a": {"f0_condition": False, "auto_f0_adjust": False},
    "b": {"f0_condition": True, "auto_f0_adjust": True},
}


def reply(proto, **fields):
    proto.write(json.dumps(fields) + "\n")
    proto.flush()


def fetch_seed_vc(home: str) -> str:
    """The pinned Seed-VC source in <home>/seed-vc/<commit>, downloaded the first time."""
    folder = os.path.join(home, "seed-vc", SEED_VC_COMMIT)
    done = os.path.join(folder, ".complete")
    if os.path.exists(done):
        return folder
    os.makedirs(os.path.dirname(folder), exist_ok=True)
    work = tempfile.mkdtemp(dir=os.path.dirname(folder))
    try:
        archive = os.path.join(work, "seed-vc.zip")
        print(f"Downloading Seed-VC {SEED_VC_COMMIT[:8]} ...", file=sys.stderr, flush=True)
        urllib.request.urlretrieve(SEED_VC_ZIP, archive)
        with zipfile.ZipFile(archive) as z:
            z.extractall(work)
        inner = os.path.join(work, f"seed-vc-{SEED_VC_COMMIT}")
        if os.path.isdir(folder):
            shutil.rmtree(folder)
        shutil.move(inner, folder)
        open(done, "w").close()
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return folder


def load_inference(home: str):
    """Seed-VC's inference module, its models loaded once per variant."""
    folder = fetch_seed_vc(home)
    os.chdir(folder)  # inference.py keeps ./checkpoints beside itself
    sys.path.insert(0, folder)
    import inference  # noqa: E402  (Seed-VC's, from the folder above)
    import torch  # noqa: E402

    original = inference.load_models
    cache = {}

    def load_once(args):
        key = bool(args.f0_condition)
        if key not in cache:
            cache.clear()  # one model at a time: 8 GB of VRAM is not for two
            torch.cuda.empty_cache()
            cache[key] = original(args)
        inference.fp16 = args.fp16
        return cache[key]

    inference.load_models = load_once
    return inference


def convert(inference, request: dict) -> None:
    target = request["target"]
    if not os.path.isfile(target):
        raise FileNotFoundError("no-reference")
    flags = VARIANTS[request["variant"]]
    with tempfile.TemporaryDirectory() as out_dir:
        args = SimpleNamespace(
            source=request["source"],
            target=target,
            output=out_dir,
            diffusion_steps=DIFFUSION_STEPS,
            length_adjust=LENGTH_ADJUST,
            inference_cfg_rate=INFERENCE_CFG_RATE,
            f0_condition=flags["f0_condition"],
            auto_f0_adjust=flags["auto_f0_adjust"],
            semi_tone_shift=0,
            checkpoint=None,
            config=None,
            fp16=FP16,
        )
        inference.main(args)
        made = sorted(glob.glob(os.path.join(out_dir, "*.wav")), key=os.path.getmtime)
        if not made:
            raise RuntimeError("Seed-VC wrote no audio")
        os.makedirs(os.path.dirname(request["output"]), exist_ok=True)
        shutil.move(made[-1], request["output"])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True, help="the extension's data folder for Seed-VC")
    options = parser.parse_args()
    # Set here as well as by the caller: an environment variable does not cross from WSL to a Windows program.
    os.environ["HF_HOME"] = os.path.join(options.home, "hf")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")

    # Stdout is the protocol: keep a private copy of it and send everything else to stderr.
    proto = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    sys.stdin.reconfigure(encoding="utf-8")

    try:
        import torch

        if not torch.cuda.is_available():
            reply(proto, error="torch found no CUDA GPU", code="no-cuda")
            return 1
        inference = load_inference(options.home)
    except Exception as caught:  # noqa: BLE001
        reply(proto, error=f"{type(caught).__name__}: {caught}", code="start")
        return 1
    reply(proto, ready=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = json.loads(line)
        try:
            convert(inference, request)
            reply(proto, id=request["id"])
        except FileNotFoundError as caught:
            code = "no-reference" if str(caught) == "no-reference" else "convert"
            reply(proto, id=request["id"], error=f"{caught}", code=code)
        except Exception as caught:  # noqa: BLE001
            reply(proto, id=request["id"], error=f"{type(caught).__name__}: {caught}", code="convert")
    return 0


if __name__ == "__main__":
    sys.exit(main())
