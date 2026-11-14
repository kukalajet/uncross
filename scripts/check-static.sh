#!/usr/bin/env bash
# Static checks for the code that is not TypeScript: shellcheck on the shell
# scripts, actionlint and zizmor on the GitHub workflows. CI's `static` job and
# `pnpm check:static` both run this script, so they use the same tool versions.
# It needs Docker, so it is not part of `pnpm check`, which the image build
# also runs.
set -euo pipefail
cd "$(dirname "$0")/.."

# Each image is pinned by digest. The comment above it lets Renovate update the
# tag and the digest together.
# renovate: datasource=docker depName=koalaman/shellcheck
shellcheck_image=koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d
# renovate: datasource=docker depName=rhysd/actionlint
actionlint_image=rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667
# renovate: datasource=docker depName=ghcr.io/zizmorcore/zizmor
zizmor_image=ghcr.io/zizmorcore/zizmor:1.31.1@sha256:42d409dbb851d4c5d35a058cf042b828bea1e3f2884378c526eb0974780e18d9

# A shell script is any tracked or new, unignored file that ends in .sh or
# starts with a sh, bash, dash or ksh shebang, so a new script is checked before
# it is committed, whatever its name. The Git hooks in .vite-hooks have no
# shebang; a `# shellcheck shell=sh` directive in each names their shell.
shebang_pattern='^#!.*[/[:space:]](sh|bash|dash|ksh)([[:space:]]|$)'
scripts=()
while IFS= read -r -d '' file; do
  # A deleted file stays in the index until the deletion is staged.
  [[ -f $file ]] || continue
  first_line=
  IFS= read -r first_line < "$file" || true
  if [[ $file == *.sh || $file == .vite-hooks/* || $first_line =~ $shebang_pattern ]]; then
    scripts+=("$file")
  fi
done < <(git ls-files -z --cached --others --exclude-standard)

if ((${#scripts[@]} == 0)); then
  echo "Found no shell scripts: run this from a Git checkout" >&2
  exit 1
fi

failed=()

# Every check runs even when an earlier one fails, so one run reports them all.
# The tools see the repository read-only, and only zizmor's online audits get a
# network.
run_check() {
  local name=$1
  shift
  echo "==> $name"
  if ! docker run --rm --volume "$PWD:/repo:ro" --workdir /repo "$@"; then
    failed+=("$name")
  fi
}

# --external-sources follows `source` into files that are not arguments.
run_check shellcheck --network none "$shellcheck_image" --external-sources "${scripts[@]}"

# The actionlint image includes shellcheck, so actionlint also checks the
# scripts in `run:` steps. actionlint 1.7.12 rejects concurrency's `queue` key
# in release.yml, which GitHub accepts; remove the ignore once actionlint knows
# the key.
run_check actionlint --network none "$actionlint_image" \
  -ignore 'unexpected key "queue" for "concurrency" section'

# zizmor's online audits (impostor commits, known vulnerable actions, ref
# confusion) read public data from the GitHub API and need a token. CI passes
# its read-only job token as GH_TOKEN; without one, only the offline audits run.
# --strict-collection fails on a workflow zizmor cannot parse, which it would
# otherwise skip with a warning.
zizmor_options=(--network none "$zizmor_image" --offline)
if [[ -n ${GH_TOKEN:-} ]]; then
  zizmor_options=(--env GH_TOKEN "$zizmor_image")
fi
run_check zizmor "${zizmor_options[@]}" --strict-collection .
if [[ -z ${GH_TOKEN:-} ]]; then
  echo "zizmor ran its offline audits only; set GH_TOKEN for the online audits"
fi

if ((${#failed[@]} > 0)); then
  echo "Static checks failed: ${failed[*]}" >&2
  exit 1
fi

echo "Static checks passed: shellcheck, actionlint and zizmor"
