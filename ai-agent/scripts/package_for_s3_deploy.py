"""Package agentcore_entrypoint.py + its real dependencies for AgentCore
Runtime's direct-code (S3) deployment mode, and upload the result.

Mirrors the same source-file selection the Dockerfile's `COPY . .` +
.dockerignore produce for the container-based deployment path, so both
deployment mechanisms ship the same code. Dependencies are installed as
real ARM64/Python-3.11 wheels (AgentCore Runtime's only supported
architecture), flattened into the same directory as the source so the
zip's root is directly importable - not nested in a subfolder, which is
what AgentCore's code-deployment contract requires.

Uses `uv pip install --python-platform ...` rather than plain `pip
install --platform ...`: pip's cross-platform install does not override
environment-marker evaluation (e.g. `sys_platform == "win32"`), so on a
Windows build machine it still tries to satisfy Windows-only transitive
markers (pywin32, pulled in by mcp -> strands-agents) for a Linux/ARM64
target and fails with an unsolvable conflict. uv resolves markers for the
TARGET platform correctly.

`aarch64-manylinux_2_28` (not the AWS docs' example `aarch64-manylinux2014`)
is used deliberately: some current dependencies (e.g. rapidfuzz 3.14+)
only publish wheels tagged manylinux_2_26/2_28, not manylinux2014/2_17.
manylinux_2_28 is still compatible with the older-tagged wheels other
dependencies use (a newer-glibc target can run binaries built for an
older glibc), so this one platform value satisfies both.

Usage:
    python -m scripts.package_for_s3_deploy [--upload]

--upload pushes the resulting zip to the existing AgentCore S3 code
bucket/prefix (see CODE_BUCKET/CODE_PREFIX below) via boto3. Without it,
the script only builds deployment_package.zip locally for inspection.

Deliberately does NOT call update-agent-runtime itself - pointing a live
runtime at a new package is a separate, deliberate step (env vars/role/
config should be reviewed each time, not blindly reapplied), not
something to bundle into an unattended packaging script.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import boto3

ROOT = Path(__file__).parent.parent
STAGE = ROOT / "_deploy_stage"
ZIP_PATH = ROOT / "deployment_package.zip"

CODE_BUCKET = "bedrock-agentcore-runtime-839513672240-eu-west-1-7l83d7eani"
CODE_PREFIX = "mini_erp_agent/deployment_package.zip"

# Same source selection the Dockerfile's `COPY . .` + .dockerignore produce.
INCLUDE_DIRS = ["agents", "tools", "config", "narration", "scripts", "sql", "retrieval"]
INCLUDE_FILES = [
    "agentcore_entrypoint.py",
    "agentcore_memory.py",
    "agentcore_session.py",
    "backend_client.py",
    "request_context.py",
]
EXCLUDE_PATTERNS = {"__pycache__", ".pytest_cache"}


def _copy_filtered(src: Path, dst: Path) -> None:
    def ignore(dir_path: str, names: list[str]) -> list[str]:
        return [n for n in names if n in EXCLUDE_PATTERNS or n.endswith((".pyc", ".pyo"))]

    shutil.copytree(src, dst, ignore=ignore)


def build_package() -> Path:
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir()

    for dirname in INCLUDE_DIRS:
        src = ROOT / dirname
        if src.is_dir():
            _copy_filtered(src, STAGE / dirname)

    for filename in INCLUDE_FILES:
        shutil.copy2(ROOT / filename, STAGE / filename)

    print("Installing ARM64/cp311 wheels from requirements.txt (via uv)...")
    subprocess.run(
        [
            sys.executable,
            "-m",
            "uv",
            "pip",
            "install",
            "--python-platform",
            "aarch64-manylinux_2_28",
            "--python-version",
            "3.11",
            "--target",
            str(STAGE),
            "--only-binary=:all:",
            "-r",
            str(ROOT / "requirements.txt"),
        ],
        check=True,
    )

    if ZIP_PATH.exists():
        ZIP_PATH.unlink()

    print(f"Zipping to {ZIP_PATH} ...")
    with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in STAGE.rglob("*"):
            if path.is_file():
                zf.write(path, path.relative_to(STAGE))

    shutil.rmtree(STAGE)

    size_mb = ZIP_PATH.stat().st_size / (1024 * 1024)
    print(f"Done: {ZIP_PATH} ({size_mb:.1f} MB)")
    if size_mb > 250:
        raise RuntimeError(
            f"{ZIP_PATH} is {size_mb:.1f} MB, over AgentCore's 250MB zipped limit."
        )
    return ZIP_PATH


def upload_package(zip_path: Path) -> str:
    print(f"Uploading to s3://{CODE_BUCKET}/{CODE_PREFIX} ...")
    boto3.client("s3").upload_file(str(zip_path), CODE_BUCKET, CODE_PREFIX)
    uri = f"s3://{CODE_BUCKET}/{CODE_PREFIX}"
    print(f"Uploaded: {uri}")
    return uri


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--upload",
        action="store_true",
        help="Also upload the built package to the AgentCore code S3 bucket.",
    )
    args = parser.parse_args()

    zip_path = build_package()
    if args.upload:
        upload_package(zip_path)
    else:
        print("Skipped upload (pass --upload to also push to S3).")


if __name__ == "__main__":
    main()
